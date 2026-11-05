// Process-local live progress for running CLI turns. CLI transcripts are
// imported only after the turn settles, so callers that observe a running
// child need this bounded, run-scoped projection. Steering itself goes through
// the reply operation's message injection.
import { onAgentEventForRun, type AgentEventPayload } from "../../infra/agent-events.js";
import { redactToolPayloadText } from "../../logging/redact.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";

const RECENT_TOOLS_LIMIT = 8;
const RECENT_TEXT_MAX_CHARS = 600;
// Longer text is redacted whole before being cut to this window.
const RECENT_TEXT_RAW_WINDOW_CHARS = 8_000;
const ACTIVE_TOOLS_LIMIT = 16;

export type CliLiveProgressSnapshot = {
  runId: string;
  provider: string;
  startedAt: number;
  lastActivityAt: number;
  /** Tool calls started and not yet answered, newest last; capped. */
  activeTools: string[];
  /** All retained unanswered tool calls, including any beyond the exposed list. */
  activeToolCount: number;
  recentTools: Array<{ name: string; phase: "start" | "result"; at: number; isError?: true }>;
  /** Redacted tail of the latest assistant or commentary text. */
  recentText?: string;
  /** Whether the running turn currently accepts steered messages. */
  steerable: boolean;
};

type CliLiveRun = {
  runId: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider: string;
  startedAt: number;
  lastActivityAt: number;
  activeTools: Map<string, string>;
  recentTools: CliLiveProgressSnapshot["recentTools"];
  recentText?: string;
  isSteerable: () => boolean;
  closed: boolean;
};

const runsById = new Map<string, CliLiveRun>();
// Bare session keys repeat across agent stores, so progress is indexed per agent.
const runsBySessionKey = new Map<string, CliLiveRun>();

function sessionIndexKey(agentId: string, sessionKey: string): string {
  return JSON.stringify([agentId, sessionKey]);
}

function boundRawText(text: string): string {
  if (text.length <= RECENT_TEXT_RAW_WINDOW_CHARS) {
    return text;
  }
  // Cutting first would strip the context (a PEM header, a key prefix) the redactor needs.
  return redactToolPayloadText(text).slice(-RECENT_TEXT_RAW_WINDOW_CHARS);
}

function trimTail(text: string): string {
  // Redact before cutting so a truncated credential never loses its recognizable prefix.
  const normalized = redactToolPayloadText(text).replace(/\s+/gu, " ").trim();
  return normalized.length > RECENT_TEXT_MAX_CHARS
    ? `…${normalized.slice(-RECENT_TEXT_MAX_CHARS)}`
    : normalized;
}

function noteAgentEvent(run: CliLiveRun, event: AgentEventPayload) {
  const data = event.data;
  const at = Date.now();
  if (event.stream === "tool") {
    const name = typeof data.name === "string" ? data.name : "";
    const callId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
    if (!name || (data.phase !== "start" && data.phase !== "result")) {
      return;
    }
    run.lastActivityAt = at;
    if (data.phase === "start") {
      if (callId) {
        run.activeTools.set(callId, name);
        // Unanswered calls are retained only up to a fixed bound; the oldest are forgotten.
        while (run.activeTools.size > ACTIVE_TOOLS_LIMIT * 4) {
          const oldest = run.activeTools.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          run.activeTools.delete(oldest);
        }
      }
    } else if (callId) {
      run.activeTools.delete(callId);
    }
    run.recentTools.push({
      name,
      phase: data.phase,
      at,
      ...(data.phase === "result" && data.isError === true ? { isError: true as const } : {}),
    });
    run.recentTools.splice(0, Math.max(0, run.recentTools.length - RECENT_TOOLS_LIMIT));
    return;
  }
  if (event.stream === "assistant") {
    const text =
      typeof data.completedText === "string" && data.completedText
        ? data.completedText
        : typeof data.text === "string"
          ? data.text
          : "";
    if (text.trim()) {
      run.lastActivityAt = at;
      run.recentText = boundRawText(text);
    }
    return;
  }
  if (event.stream === "item" && typeof data.progressText === "string" && data.progressText) {
    run.lastActivityAt = at;
    run.recentText = boundRawText(data.progressText);
    return;
  }
  if (event.stream === "thinking") {
    run.lastActivityAt = at;
  }
}

function isRunSteerable(run: CliLiveRun): boolean {
  try {
    return !run.closed && run.isSteerable();
  } catch {
    return false;
  }
}

function snapshot(run: CliLiveRun): CliLiveProgressSnapshot {
  return {
    runId: run.runId,
    provider: run.provider,
    startedAt: run.startedAt,
    lastActivityAt: run.lastActivityAt,
    activeTools: [...run.activeTools.values()].slice(-ACTIVE_TOOLS_LIMIT),
    activeToolCount: run.activeTools.size,
    recentTools: run.recentTools.map((entry) => ({ ...entry })),
    ...(run.recentText ? { recentText: trimTail(run.recentText) } : {}),
    steerable: isRunSteerable(run),
  };
}

export type CliLiveRunRegistration = {
  close(): void;
};

/** Track one admitted CLI turn. A newer turn for the same run or session replaces it. */
export function registerCliLiveRun(params: {
  runId: string;
  provider: string;
  /** Owning agent; without it the run's progress is never projected. */
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  /** Whether the turn's message injection currently accepts steered input. */
  isSteerable?: () => boolean;
}): CliLiveRunRegistration {
  const now = Date.now();
  const agentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
  const indexKey =
    agentId && params.sessionKey ? sessionIndexKey(agentId, params.sessionKey) : undefined;
  const run: CliLiveRun = {
    runId: params.runId,
    ...(agentId ? { agentId } : {}),
    provider: params.provider,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    startedAt: now,
    lastActivityAt: now,
    activeTools: new Map(),
    recentTools: [],
    isSteerable: params.isSteerable ?? (() => false),
    closed: false,
  };
  runsById.set(params.runId, run);
  if (indexKey) {
    runsBySessionKey.set(indexKey, run);
  }
  const unsubscribe = onAgentEventForRun(params.runId, (event) => {
    if (!run.closed) {
      noteAgentEvent(run, event);
    }
  });
  return {
    close() {
      if (run.closed) {
        return;
      }
      run.closed = true;
      unsubscribe();
      if (runsById.get(run.runId) === run) {
        runsById.delete(run.runId);
      }
      if (indexKey && runsBySessionKey.get(indexKey) === run) {
        runsBySessionKey.delete(indexKey);
      }
    },
  };
}

/**
 * Track a CLI turn until its signal aborts; the runner aborts it when the turn closes.
 * Side questions answer inline and never publish progress to observers.
 */
export function registerCliLiveRunForTurn(
  run: {
    runId: string;
    provider: string;
    agentId?: string;
    sessionId?: string;
    sessionKey?: string;
    executionMode?: string;
  },
  signal: AbortSignal,
  acceptsInjection: () => boolean,
): void {
  if (run.executionMode === "side-question" || signal.aborted) {
    return;
  }
  const live = registerCliLiveRun({
    runId: run.runId,
    provider: run.provider,
    agentId: run.agentId ?? parseAgentSessionKey(run.sessionKey)?.agentId,
    sessionId: run.sessionId,
    sessionKey: run.sessionKey,
    isSteerable: () => !signal.aborted && acceptsInjection(),
  });
  signal.addEventListener("abort", () => live.close(), { once: true });
}

/**
 * Bounded progress for the session's current CLI turn, if one is running here.
 * Callers pass the identity they already authorized; an expected session id
 * rejects a replacement incarnation that reuses the key.
 */
export function getCliLiveProgressForSession(params: {
  agentId: string;
  sessionKey: string;
  sessionId?: string;
}): CliLiveProgressSnapshot | undefined {
  const run = runsBySessionKey.get(
    sessionIndexKey(normalizeAgentId(params.agentId), params.sessionKey),
  );
  if (!run || run.closed || (params.sessionId && run.sessionId !== params.sessionId)) {
    return undefined;
  }
  return snapshot(run);
}

export const testing = {
  reset() {
    for (const run of runsById.values()) {
      run.closed = true;
    }
    runsById.clear();
    runsBySessionKey.clear();
  },
};
