import { onAgentEventForRun, type AgentEventPayload } from "../../infra/agent-events.js";
import { redactToolPayloadText } from "../../logging/redact.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { sanitizeRunStatusText } from "../run-status-text.js";

const RECENT_TOOLS_LIMIT = 8;
const ACTIVE_TOOLS_LIMIT = 16;
const ACTIVE_TOOLS_TRACKED_LIMIT = 64;
const RECENT_TEXT_MAX_CHARS = 600;
const TOOL_NAME_MAX_CHARS = 80;

type ToolActivity = { name: string; phase: "start" | "result"; at: number; isError?: true };

export type CliLiveProgressSnapshot = {
  runId: string;
  provider: string;
  startedAt: number;
  lastActivityAt: number;
  activeTools: string[];
  activeToolCount: number;
  recentTools: ToolActivity[];
  recentText?: string;
  steerable: boolean;
};

type SessionScope = { agentId: string; sessionKey: string; sessionId?: string };
type CliLiveRun = {
  runId: string;
  provider: string;
  sessionId?: string;
  startedAt: number;
  lastActivityAt: number;
  activeTools: Map<string, string>;
  recentTools: ToolActivity[];
  recentText?: string;
  acceptsInjection: () => boolean;
  close: () => void;
};

const runsById = new Map<string, CliLiveRun>();
const runsBySession = new Map<string, CliLiveRun>();

function sessionIndexKey(agentId: string, sessionKey: string): string {
  return JSON.stringify([normalizeAgentId(agentId), sessionKey]);
}

function noteEvent(run: CliLiveRun, event: AgentEventPayload): void {
  const { data, stream } = event;
  const at = Date.now();
  if (stream === "tool") {
    const { phase, toolCallId } = data;
    if (typeof data.name !== "string" || !data.name || (phase !== "start" && phase !== "result")) {
      return;
    }
    const name = sanitizeRunStatusText(redactToolPayloadText(data.name), {
      maxChars: TOOL_NAME_MAX_CHARS,
    });
    if (!name) {
      return;
    }
    run.lastActivityAt = at;
    if (typeof toolCallId === "string" && toolCallId) {
      if (phase === "result") {
        run.activeTools.delete(toolCallId);
      } else {
        run.activeTools.set(toolCallId, name);
        if (run.activeTools.size > ACTIVE_TOOLS_TRACKED_LIMIT) {
          const oldest = run.activeTools.keys().next().value;
          if (oldest !== undefined) {
            run.activeTools.delete(oldest);
          }
        }
      }
    }
    run.recentTools.push({
      name,
      phase,
      at,
      ...(phase === "result" && data.isError === true ? { isError: true } : {}),
    });
    if (run.recentTools.length > RECENT_TOOLS_LIMIT) {
      run.recentTools.shift();
    }
    return;
  }
  if (stream === "thinking") {
    run.lastActivityAt = at;
    return;
  }
  const text =
    stream === "assistant"
      ? typeof data.completedText === "string" && data.completedText
        ? data.completedText
        : data.text
      : stream === "item"
        ? data.progressText
        : undefined;
  if (typeof text !== "string" || !text.trim()) {
    return;
  }
  run.lastActivityAt = at;
  const sanitized = sanitizeRunStatusText(redactToolPayloadText(text));
  run.recentText =
    sanitized.length > RECENT_TEXT_MAX_CHARS
      ? `…${sanitized.slice(1 - RECENT_TEXT_MAX_CHARS).replace(/^[\uDC00-\uDFFF]/u, "")}`
      : sanitized;
}

export function registerCliLiveRunForTurn(
  input: {
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
  const { runId, provider, sessionId, sessionKey } = input;
  const agentId = input.agentId ?? parseAgentSessionKey(sessionKey)?.agentId;
  if (!agentId || !sessionKey || input.executionMode === "side-question" || signal.aborted) {
    return;
  }
  const key = sessionIndexKey(agentId, sessionKey);
  runsBySession.get(key)?.close();
  runsById.get(runId)?.close();
  const now = Date.now();
  const run: CliLiveRun = {
    runId,
    provider,
    sessionId,
    startedAt: now,
    lastActivityAt: now,
    activeTools: new Map(),
    recentTools: [],
    acceptsInjection,
    close() {
      unsubscribe();
      signal.removeEventListener("abort", run.close);
      runsBySession.delete(key);
      runsById.delete(runId);
    },
  };
  const unsubscribe = onAgentEventForRun(runId, (event) => noteEvent(run, event));
  runsBySession.set(key, run);
  runsById.set(runId, run);
  signal.addEventListener("abort", run.close, { once: true });
}

export function getCliLiveProgressForSession(
  scope: SessionScope & { runId?: string },
): CliLiveProgressSnapshot | undefined {
  const run = runsBySession.get(sessionIndexKey(scope.agentId, scope.sessionKey));
  if (
    !run ||
    (scope.sessionId !== undefined && run.sessionId !== scope.sessionId) ||
    (scope.runId !== undefined && run.runId !== scope.runId)
  ) {
    return undefined;
  }
  let steerable = false;
  try {
    steerable = run.acceptsInjection();
  } catch {
    steerable = false;
  }
  return {
    runId: run.runId,
    provider: run.provider,
    startedAt: run.startedAt,
    lastActivityAt: run.lastActivityAt,
    activeTools: [...run.activeTools.values()].slice(-ACTIVE_TOOLS_LIMIT),
    activeToolCount: run.activeTools.size,
    recentTools: run.recentTools.map((entry) => ({ ...entry })),
    ...(run.recentText ? { recentText: run.recentText } : {}),
    steerable,
  };
}
