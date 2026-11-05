import { onAgentEventForRun, type AgentEventPayload } from "../../infra/agent-events.js";
import { redactSensitiveText } from "../../logging/redact.js";
// Process-local view of running CLI turns: parent steering and live progress.
// CLI transcripts are imported only after the turn settles, so callers that
// observe or steer a running child need this bounded, run-scoped projection.
import type {
  CliBackendSteeringCapability,
  CliBackendSteeringInputState,
  CliBackendSteeringSink,
} from "../../plugins/cli-backend.types.js";

/** Plain-text steering above this size belongs in a file or a new turn. */
export const CLI_STEERING_MAX_CHARS = 32_000;
const RECENT_TOOLS_LIMIT = 8;
const STEERING_HISTORY_LIMIT = 8;
const RECENT_TEXT_MAX_CHARS = 600;

export type CliLiveSteeringEntry = {
  id: string;
  state: CliBackendSteeringInputState;
  queuedAt: number;
  consumedAt?: number;
  settledAt?: number;
};

export type CliLiveProgressSnapshot = {
  runId: string;
  provider: string;
  startedAt: number;
  lastActivityAt: number;
  /** Tool calls started and not yet answered, oldest first. */
  activeTools: string[];
  recentTools: Array<{ name: string; phase: "start" | "result"; at: number; isError?: true }>;
  /** Redacted tail of the latest assistant or commentary text. */
  recentText?: string;
  /** Whether the running turn currently accepts parent steering. */
  steerable: boolean;
  steering: CliLiveSteeringEntry[];
};

type CliLiveRun = {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  provider: string;
  startedAt: number;
  lastActivityAt: number;
  activeTools: Map<string, string>;
  recentTools: CliLiveProgressSnapshot["recentTools"];
  recentText?: string;
  sink?: CliBackendSteeringSink;
  steering: CliLiveSteeringEntry[];
  closed: boolean;
};

const runsById = new Map<string, CliLiveRun>();
const runsBySessionKey = new Map<string, CliLiveRun>();

function trimTail(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  const tail =
    normalized.length > RECENT_TEXT_MAX_CHARS
      ? `…${normalized.slice(-RECENT_TEXT_MAX_CHARS)}`
      : normalized;
  return redactSensitiveText(tail, { mode: "tools" });
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
      run.recentText = text;
    }
    return;
  }
  if (event.stream === "item" && typeof data.progressText === "string" && data.progressText) {
    run.lastActivityAt = at;
    run.recentText = data.progressText;
    return;
  }
  if (event.stream === "thinking") {
    run.lastActivityAt = at;
  }
}

function isSinkAvailable(run: CliLiveRun): boolean {
  try {
    return !run.closed && run.sink?.isAvailable() === true;
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
    activeTools: [...run.activeTools.values()],
    recentTools: run.recentTools.map((entry) => ({ ...entry })),
    ...(run.recentText ? { recentText: trimTail(run.recentText) } : {}),
    steerable: isSinkAvailable(run),
    steering: run.steering.map((entry) => ({ ...entry })),
  };
}

function updateSteering(run: CliLiveRun, id: string, state: CliBackendSteeringInputState) {
  const entry = run.steering.find((candidate) => candidate.id === id);
  if (!entry || entry.state === "completed" || entry.state === "dropped") {
    return;
  }
  const at = Date.now();
  entry.state = state;
  if (state === "consumed") {
    entry.consumedAt ??= at;
  } else if (state === "completed" || state === "dropped") {
    entry.settledAt = at;
  }
  run.lastActivityAt = Math.max(run.lastActivityAt, at);
}

export type CliLiveRunRegistration = {
  /** Host capability handed to the plugin for exactly this turn. */
  steering: CliBackendSteeringCapability;
  close(): void;
};

/** Track one admitted CLI turn. A newer turn for the same run or session replaces it. */
export function registerCliLiveRun(params: {
  runId: string;
  provider: string;
  sessionId?: string;
  sessionKey?: string;
}): CliLiveRunRegistration {
  const now = Date.now();
  const run: CliLiveRun = {
    runId: params.runId,
    provider: params.provider,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    startedAt: now,
    lastActivityAt: now,
    activeTools: new Map(),
    recentTools: [],
    steering: [],
    closed: false,
  };
  runsById.set(params.runId, run);
  if (params.sessionKey) {
    runsBySessionKey.set(params.sessionKey, run);
  }
  const unsubscribe = onAgentEventForRun(params.runId, (event) => {
    if (!run.closed) {
      noteAgentEvent(run, event);
    }
  });
  return {
    steering: {
      attach(sink) {
        if (run.closed) {
          return () => {};
        }
        run.sink = sink;
        return () => {
          if (run.sink === sink) {
            run.sink = undefined;
          }
        };
      },
    },
    close() {
      if (run.closed) {
        return;
      }
      run.closed = true;
      run.sink = undefined;
      unsubscribe();
      for (const entry of run.steering) {
        if (entry.state === "queued") {
          updateSteering(run, entry.id, "dropped");
        }
      }
      if (runsById.get(run.runId) === run) {
        runsById.delete(run.runId);
      }
      if (run.sessionKey && runsBySessionKey.get(run.sessionKey) === run) {
        runsBySessionKey.delete(run.sessionKey);
      }
    },
  };
}

function resolveRun(runId: string, sessionId?: string): CliLiveRun | undefined {
  const run = runsById.get(runId);
  if (!run || run.closed || (sessionId && run.sessionId && run.sessionId !== sessionId)) {
    return undefined;
  }
  return run;
}

/** True only while the plugin has an admitted, steerable turn for this exact run. */
export function isCliLiveRunSteerable(runId: string, sessionId?: string): boolean {
  const run = resolveRun(runId, sessionId);
  return run ? isSinkAvailable(run) : false;
}

export type CliLiveSteeringResult = { id: string; acknowledged: boolean };

/**
 * Deliver one plain-text message into the running CLI turn. The caller's guarded
 * assertion runs inside the plugin immediately before the native write.
 */
export async function deliverCliLiveRunSteering(params: {
  runId: string;
  sessionId?: string;
  text: string;
  assertCurrent: () => void;
}): Promise<CliLiveSteeringResult> {
  const run = resolveRun(params.runId, params.sessionId);
  const sink = run?.sink;
  if (!run || !sink || !sink.isAvailable()) {
    throw new Error("The CLI run is not accepting steering.");
  }
  if (!params.text.trim()) {
    throw new Error("Steering text is empty.");
  }
  if (params.text.length > CLI_STEERING_MAX_CHARS) {
    throw new Error(`Steering text exceeds ${CLI_STEERING_MAX_CHARS} characters.`);
  }
  let entry: CliLiveSteeringEntry | undefined;
  const result = await sink.deliver({
    text: params.text,
    assertCurrent: () => {
      params.assertCurrent();
      if (run.closed || run.sink !== sink || runsById.get(run.runId) !== run) {
        throw new Error("The CLI run is no longer accepting steering.");
      }
    },
    onQueued: (id) => {
      entry = { id, state: "queued", queuedAt: Date.now() };
      run.steering.push(entry);
      run.steering.splice(0, Math.max(0, run.steering.length - STEERING_HISTORY_LIMIT));
    },
    onState: (id, state) => updateSteering(run, id, state),
  });
  return { id: result.id, acknowledged: result.acknowledged };
}

/** Bounded progress for the session's current CLI turn, if one is running here. */
export function getCliLiveProgressForSession(
  sessionKey: string | undefined,
): CliLiveProgressSnapshot | undefined {
  const run = sessionKey ? runsBySessionKey.get(sessionKey) : undefined;
  return run && !run.closed ? snapshot(run) : undefined;
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
