import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionHandle,
  CliBackendSteeringInputState,
  CliBackendSteeringSink,
  CliBackendToolPermissionResult,
} from "openclaw/plugin-sdk/cli-backend";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  CLAUDE_PROMPT_HOOK_CALLBACK_IDS,
  resolveClaudePromptHookPart,
  splitClaudeHookAdditionalContext,
} from "./cli-hook-context.js";
import { hasClaudeRawToolInvocation } from "./cli-output.js";
import type { ClaudeCliSecretInput } from "./cli-process.js";
import { prepareClaudeCliTransportArgs } from "./cli-runtime-args.js";
import { createClaudeCliTransport } from "./cli-transport.js";
import { createClaudeCliUserInputAuthorizer } from "./cli-user-input.js";

const IDLE_TIMEOUT_MS = 10 * 60 * 1_000;

function readReplayedTaskId(
  message: Record<string, unknown>,
  inputUuid: string,
): string | undefined {
  if (
    message.type !== "user" ||
    message.isReplay !== true ||
    message.parent_tool_use_id !== null ||
    message.uuid === inputUuid ||
    !isRecord(message.message)
  ) {
    return undefined;
  }
  // Before Claude Code 2.1.274, inline notification receipts omitted origin.
  if (
    message.origin !== undefined &&
    (!isRecord(message.origin) ||
      message.origin.kind !== "task-notification" ||
      message.origin.subkind !== undefined)
  ) {
    return undefined;
  }
  const content = message.message.content;
  const first = Array.isArray(content) ? content[0] : undefined;
  const text =
    typeof content === "string"
      ? content
      : isRecord(first) && first.type === "text" && typeof first.text === "string"
        ? first.text
        : "";
  return /^<task-notification>\s*<task-id>([^<]+)<\/task-id>/u.exec(text)?.[1];
}

/** Native acknowledgement of a written steering line; later lines may still be in flight. */
const STEERING_ACK_TIMEOUT_MS = 5_000;
// Native print mode runs a leading "/name" as a local command even mid-turn.
const STEERING_HEADER = "[Message received while this turn was running]";

type ClaudeCliSteeringInput = {
  /** pending: written, not yet acknowledged by the native command queue. */
  state: "pending" | "queued" | "consumed";
  onState: (id: string, state: CliBackendSteeringInputState) => void;
  acknowledge: (acknowledged: boolean) => void;
};

type ClaudeCliTurn = {
  context: CliBackendExecuteContext;
  controller: AbortController;
  userInput: ReturnType<typeof createClaudeCliUserInputAuthorizer>;
  events: PassThrough;
  inputUuid: string;
  inputStarted: boolean;
  sawTerminalResult: boolean;
  /** Parent steering written into this turn and not yet answered. */
  steering: Map<string, ClaudeCliSteeringInput>;
  /** A successful result held only because steering still waits for its own query. */
  heldForSteering?: Record<string, unknown>;
  /** A written steering line lost its acknowledgement; native may still run it later. */
  steeringUnsettled?: boolean;
  foregroundTaskIds: Set<string>;
  foregroundBashToolUseIds: Set<string>;
  pendingBackgroundTaskIds: Set<string>;
  subagentTaskIds: Set<string>;
  taskNotifications: Map<string, "queued" | "replayed">;
  error?: Error;
};
type ClaudeCliSession = {
  handle: CliBackendLiveSessionHandle;
  capability?: CliBackendLiveSessionCapability;
  transport?: ReturnType<typeof createClaudeCliTransport>;
  currentTurn?: ClaudeCliTurn;
  idleTimer?: ReturnType<typeof setTimeout>;
  hasInputLifecycle: boolean;
  closed: boolean;
};
const sessions = new WeakMap<CliBackendLiveSessionHandle, ClaudeCliSession>();

function activeTurn(session: ClaudeCliSession): ClaudeCliTurn | undefined {
  const turn = session.currentTurn;
  if (!turn || turn.controller.signal.aborted || turn.context.abortSignal?.aborted) {
    return undefined;
  }
  // A warm child can emit prior-input callbacks while the next admitted input is queued.
  if (session.hasInputLifecycle && !turn.inputStarted) {
    return undefined;
  }
  try {
    turn.context.assertCurrent?.();
    return turn;
  } catch {
    return undefined;
  }
}

async function authorizeTool(
  session: ClaudeCliSession,
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<CliBackendToolPermissionResult> {
  const turn = activeTurn(session);
  const { input, tool_name: toolName } = request;
  if (!turn || signal.aborted || typeof toolName !== "string" || !isRecord(input)) {
    return {
      behavior: "deny",
      message: "The OpenClaw run or native tool input is no longer valid.",
    };
  }
  const toolUseId = typeof request.tool_use_id === "string" ? request.tool_use_id : undefined;
  const abortSignal = AbortSignal.any([signal, turn.controller.signal]);
  try {
    const decision =
      toolName === "AskUserQuestion"
        ? await turn.userInput.authorize({ input, signal: abortSignal, toolUseId })
        : await turn.context.requestToolPermission({
            toolName,
            toolInput: input,
            cwd: typeof request.cwd === "string" ? request.cwd : undefined,
            toolCallId: toolUseId,
            abortSignal,
          });
    // An operator decision can outlive its turn. Revalidate immediately before granting it.
    if (activeTurn(session) !== turn || abortSignal.aborted) {
      return { behavior: "deny", message: "The OpenClaw run is no longer active." };
    }
    if (
      decision.behavior === "allow" &&
      toolName === "Bash" &&
      toolUseId &&
      decision.updatedInput.run_in_background !== true
    ) {
      // Native may first announce an automatic timeout as already backgrounded.
      // The authorized input distinguishes it from explicit run_in_background work.
      turn.foregroundBashToolUseIds.add(toolUseId);
    }
    return decision;
  } catch {
    return { behavior: "deny", message: "OpenClaw could not authorize this tool call." };
  }
}

const promptHookPartsByTurn = new WeakMap<object, readonly string[]>();

async function handleRequest(
  session: ClaudeCliSession,
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  if (request.subtype === "can_use_tool") {
    return { ...(await authorizeTool(session, request, signal)), toolUseID: request.tool_use_id };
  }
  if (request.subtype !== "hook_callback" || !isRecord(request.input)) {
    throw new Error("Unsupported Claude CLI control request.");
  }
  const input = request.input;
  const turn = activeTurn(session);
  const promptHookPart = resolveClaudePromptHookPart(request.callback_id);
  if (promptHookPart !== undefined && input.hook_event_name === "UserPromptSubmit") {
    if (!turn || signal.aborted) {
      return {};
    }
    // Native can rewrite the prompt and rerun hooks; only its final pass is persisted.
    // Each callback answers one part so no single hook output reaches the preview threshold.
    // Split once per turn so every callback of that turn answers from the same partition.
    let parts = promptHookPartsByTurn.get(turn.context);
    if (!parts) {
      parts = splitClaudeHookAdditionalContext(
        [turn.context.promptContext?.prependContext, turn.context.promptContext?.appendContext]
          .filter(Boolean)
          .join("\n\n"),
      );
      promptHookPartsByTurn.set(turn.context, parts);
    }
    const additionalContext = parts[promptHookPart];
    return additionalContext
      ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }
      : {};
  }
  if (request.callback_id === "PreToolUse" && input.hook_event_name === "PreToolUse") {
    if (
      turn &&
      !signal.aborted &&
      typeof input.tool_name === "string" &&
      input.tool_name.startsWith("mcp__openclaw__")
    ) {
      return { continue: true };
    }
    // Native settings can grant tools before can_use_tool. This hook preserves host policy.
    const decision = await authorizeTool(
      session,
      {
        tool_name: input.tool_name,
        input: input.tool_input,
        cwd: input.cwd,
        tool_use_id: request.tool_use_id ?? input.tool_use_id,
      },
      signal,
    );
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision.behavior,
        ...(decision.behavior === "allow"
          ? { updatedInput: decision.updatedInput }
          : { permissionDecisionReason: decision.message }),
      },
    };
  }
  throw new Error("Unknown Claude CLI hook callback.");
}

function settleSteering(
  turn: ClaudeCliTurn,
  id: string,
  state: Exclude<CliBackendSteeringInputState, "queued"> | "acknowledged",
) {
  const input = turn.steering.get(id);
  if (!input) {
    return;
  }
  if (state === "acknowledged" || state === "consumed") {
    input.acknowledge(true);
    if (input.state === "pending") {
      input.state = "queued";
    }
    if (state === "consumed" && input.state !== "consumed") {
      input.state = "consumed";
      // A started steering query owns the held result's continuation.
      turn.heldForSteering = undefined;
      input.onState(id, "consumed");
    }
    return;
  }
  turn.steering.delete(id);
  input.acknowledge(state === "completed");
  input.onState(id, state);
}

function dropSteering(turn: ClaudeCliTurn) {
  // Deleting the visited key during Map iteration is well-defined.
  for (const id of turn.steering.keys()) {
    settleSteering(turn, id, "dropped");
  }
}

/** Unconsumed steering runs as its own native query after the current result. */
function awaitsSteeringQuery(turn: ClaudeCliTurn): boolean {
  return [...turn.steering.values()].some((input) => input.state !== "consumed");
}

function closeSession(session: ClaudeCliSession, error?: unknown) {
  if (session.closed) {
    return;
  }
  session.closed = true;
  clearTimeout(session.idleTimer);
  session.capability?.remove(session.handle);
  const turn = session.currentTurn;
  session.currentTurn = undefined;
  if (turn) {
    dropSteering(turn);
    turn.error = toErrorObject(error, "Claude CLI live session closed.");
    turn.controller.abort();
    turn.events.end();
  }
  session.transport?.close();
}

function completeTurn(session: ClaudeCliSession, turn: ClaudeCliTurn) {
  // Queued steering would start an unowned native query in a warm process.
  const holdsBackgroundTasks =
    turn.pendingBackgroundTaskIds.size > 0 ||
    awaitsSteeringQuery(turn) ||
    turn.steeringUnsettled === true;
  dropSteering(turn);
  turn.heldForSteering = undefined;
  session.currentTurn = undefined;
  turn.controller.abort();
  turn.events.end();
  if (!session.capability || holdsBackgroundTasks) {
    // A failed parent does not stop native background continuations. Never lend them a new turn.
    session.handle.close(holdsBackgroundTasks ? "abort" : "idle");
  } else {
    session.idleTimer = setTimeout(() => session.handle.close("idle"), IDLE_TIMEOUT_MS);
    session.idleTimer.unref();
  }
}

async function acceptMessage(session: ClaudeCliSession, message: Record<string, unknown>) {
  if (message.type === "system" && message.subtype === "init") {
    session.hasInputLifecycle =
      Array.isArray(message.capabilities) && message.capabilities.includes("msg_lifecycle_v1");
  }
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  if (message.type === "command_lifecycle") {
    if (message.state === "started" && message.command_uuid === turn.inputUuid) {
      turn.inputStarted = true;
    }
    if (typeof message.command_uuid === "string" && turn.steering.has(message.command_uuid)) {
      const id = message.command_uuid;
      if (message.state === "queued") {
        settleSteering(turn, id, "acknowledged");
      } else if (message.state === "started") {
        settleSteering(turn, id, "consumed");
      } else if (message.state === "completed") {
        settleSteering(turn, id, "completed");
      } else if (message.state === "cancelled") {
        settleSteering(turn, id, "dropped");
        releaseHeldResult(session, turn);
      }
    }
    return;
  }
  // The replay receipt proves the model received steering, even without lifecycle records.
  if (
    message.type === "user" &&
    message.isReplay === true &&
    typeof message.uuid === "string" &&
    turn.steering.has(message.uuid)
  ) {
    settleSteering(turn, message.uuid, "consumed");
  }
  // Newer CLI builds identify the submitted input; ignore replayed prior-turn output.
  if (
    session.hasInputLifecycle &&
    !turn.inputStarted &&
    !(message.type === "system" && message.subtype === "init")
  ) {
    return;
  }
  if (message.type === "system" && message.subtype === "task_started") {
    if (message.owned_by_subagent === true) {
      if (typeof message.task_id === "string" && message.task_id) {
        turn.subagentTaskIds.add(message.task_id);
      }
    } else if (typeof message.task_id === "string" && message.task_id) {
      // task_type is optional here; the background task list names it later.
      if (message.is_backgrounded === false) {
        turn.foregroundTaskIds.add(message.task_id);
      }
      const foregroundBash =
        typeof message.tool_use_id === "string" &&
        turn.foregroundBashToolUseIds.delete(message.tool_use_id);
      if (foregroundBash && message.is_backgrounded === true) {
        turn.pendingBackgroundTaskIds.add(message.task_id);
      }
    }
  }
  if (message.type === "system" && message.subtype === "background_tasks_changed") {
    for (const task of Array.isArray(message.tasks) ? message.tasks : []) {
      if (!isRecord(task) || typeof task.task_id !== "string" || !task.task_id) {
        continue;
      }
      if (
        task.task_type === "local_agent" ||
        task.task_type === "local_workflow" ||
        (task.task_type === "local_bash" && turn.foregroundTaskIds.has(task.task_id))
      ) {
        // Leaving the live task list is not acknowledgement of its queued answer.
        turn.pendingBackgroundTaskIds.add(task.task_id);
      }
    }
  }
  // A replay receipt acknowledges consumption within the current query. Keep its
  // queue slot until that query's result so it cannot acknowledge the next task twice.
  const replayedTaskId = readReplayedTaskId(message, turn.inputUuid);
  if (replayedTaskId) {
    turn.pendingBackgroundTaskIds.delete(replayedTaskId);
    turn.foregroundTaskIds.delete(replayedTaskId);
    turn.taskNotifications.set(replayedTaskId, "replayed");
  }
  if (
    message.type === "system" &&
    message.subtype === "task_notification" &&
    typeof message.task_id === "string" &&
    message.task_id &&
    // Subagent completions have no parent result and must not consume its queue slots.
    !turn.subagentTaskIds.delete(message.task_id)
  ) {
    // Include non-held tasks: each queued notification has its own ordered result.
    turn.taskNotifications.set(message.task_id, "queued");
  }
  let completesTurn = false;
  if (message.type === "result") {
    const failed =
      message.is_error === true ||
      (typeof message.subtype === "string" && message.subtype.startsWith("error")) ||
      (typeof message.result === "string" && hasClaudeRawToolInvocation(message.result));
    const taskNotification =
      isRecord(message.origin) &&
      message.origin.kind === "task-notification" &&
      message.origin.subkind === undefined;
    if (taskNotification && message.subtype === "success" && !failed) {
      // A later task can finish during this query. Consume one notification, not all
      // completed tasks; retain pending work on failure so completeTurn retires it.
      const taskId = turn.taskNotifications.keys().next().value;
      if (taskId) {
        turn.taskNotifications.delete(taskId);
        turn.pendingBackgroundTaskIds.delete(taskId);
        turn.foregroundTaskIds.delete(taskId);
      }
    }
    // Inline receipts have no separate result. The query just answered them too.
    for (const [taskId, state] of turn.taskNotifications) {
      if (state === "replayed") {
        turn.taskNotifications.delete(taskId);
      }
    }
    // A batched notification can acknowledge input without running the model.
    const queuedContinuation =
      turn.sawTerminalResult &&
      taskNotification &&
      message.num_turns === 0 &&
      message.result === "" &&
      message.stop_reason === null &&
      message.terminal_reason === undefined;
    turn.sawTerminalResult = true;
    // Steering consumed by this query is answered by its result.
    for (const [id, input] of turn.steering) {
      if (input.state === "consumed") {
        settleSteering(turn, id, "completed");
      }
    }
    const awaitingSteering = awaitsSteeringQuery(turn);
    // Background work and unconsumed steering hold successful interim results,
    // never terminal failures.
    completesTurn =
      (turn.pendingBackgroundTaskIds.size === 0 && !queuedContinuation && !awaitingSteering) ||
      failed;
    turn.heldForSteering =
      !completesTurn &&
      awaitingSteering &&
      turn.pendingBackgroundTaskIds.size === 0 &&
      !queuedContinuation
        ? message
        : undefined;
  }
  // The transport owns continuation lifetime; the completed answer can be
  // delivered through normal reply hooks without waiting for the children.
  const outputMessage =
    message.type === "result" && !completesTurn
      ? { ...message, openclaw_interim_result: true }
      : message;
  if (!turn.events.write(outputMessage)) {
    await once(turn.events, "drain", { signal: turn.controller.signal });
  }
  if (completesTurn) {
    completeTurn(session, turn);
  }
}

/** Finish a turn whose only hold was steering that native never acknowledged. */
function releaseHeldResult(session: ClaudeCliSession, turn: ClaudeCliTurn) {
  const held = turn.heldForSteering;
  if (
    !held ||
    session.currentTurn !== turn ||
    turn.steering.size > 0 ||
    turn.pendingBackgroundTaskIds.size > 0
  ) {
    return;
  }
  turn.heldForSteering = undefined;
  // The held result already committed its text as interim; close without repeating it.
  turn.events.write({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    num_turns: 0,
    ...(typeof held.session_id === "string" ? { session_id: held.session_id } : {}),
  });
  completeTurn(session, turn);
  // An unacknowledged line may still start a native query; never keep that process warm.
  session.handle.close("abort");
}

function createSteeringSink(
  session: ClaudeCliSession,
  turn: ClaudeCliTurn,
): CliBackendSteeringSink {
  // Lifecycle records are the only proof of native queueing and consumption.
  const isAvailable = () =>
    !session.closed &&
    session.currentTurn === turn &&
    session.hasInputLifecycle &&
    session.transport !== undefined &&
    activeTurn(session) === turn;
  return {
    isAvailable,
    async deliver({ text, assertCurrent, onQueued, onState }) {
      if (typeof text !== "string" || !text.trim() || !isAvailable()) {
        throw new Error("The Claude CLI turn is not accepting steering.");
      }
      const id = randomUUID();
      const { promise: acknowledged, resolve: acknowledge } = createDeferred<boolean>();
      // Host source and run authority are revalidated at the final native effect.
      assertCurrent();
      const transport = session.transport;
      if (!transport || !isAvailable()) {
        throw new Error("The Claude CLI turn is no longer accepting steering.");
      }
      turn.steering.set(id, { state: "pending", onState, acknowledge });
      onQueued(id);
      try {
        // Text blocks only: steering never carries tool results, images, or a parent tool id.
        // The fixed first line keeps native slash commands such as /clear inert.
        await transport.send({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: `${STEERING_HEADER}\n${text}` }],
          },
          parent_tool_use_id: null,
          uuid: id,
          ...(turn.context.sessionId ? { session_id: turn.context.sessionId } : {}),
        });
      } catch (error) {
        turn.steeringUnsettled = true;
        settleSteering(turn, id, "dropped");
        throw error;
      }
      const timer = setTimeout(() => acknowledge(false), STEERING_ACK_TIMEOUT_MS);
      timer.unref?.();
      const ok = await acknowledged;
      clearTimeout(timer);
      if (!ok) {
        if (turn.steering.get(id)?.state === "pending") {
          turn.steeringUnsettled = true;
          settleSteering(turn, id, "dropped");
        }
        releaseHeldResult(session, turn);
      }
      return { id, acknowledged: ok };
    },
  };
}

function createSession(capability?: CliBackendLiveSessionCapability): ClaudeCliSession {
  const session: ClaudeCliSession = {
    capability,
    hasInputLifecycle: false,
    closed: false,
    handle: {
      generation: randomUUID(),
      fingerprint: capability?.fingerprint ?? randomUUID(),
      isIdle: () => !session.closed && !session.currentTurn,
      close: (_reason, error) => closeSession(session, error),
      waitForExit: () => session.transport?.waitForExit() ?? Promise.resolve(),
    },
  };
  sessions.set(session.handle, session);
  capability?.register(session.handle);
  return session;
}

export async function* executeClaudeCli(
  context: CliBackendExecuteContext,
  secretInput?: ClaudeCliSecretInput,
): AsyncIterable<Record<string, unknown>> {
  context.assertCurrent?.();
  context.abortSignal?.throwIfAborted();
  const capability = context.liveSession;
  const existing = capability?.current();
  const reusable =
    existing && existing.fingerprint === capability?.fingerprint
      ? sessions.get(existing)
      : undefined;
  if (!reusable && capability) {
    await capability.restart();
  }
  context.assertCurrent?.();
  const session = reusable ?? createSession(capability);
  session.capability = capability;
  if (session.closed || session.currentTurn) {
    throw new Error("Claude CLI live session is closed or already handling another turn.");
  }
  clearTimeout(session.idleTimer);
  const turn: ClaudeCliTurn = {
    context,
    controller: new AbortController(),
    userInput: createClaudeCliUserInputAuthorizer(context),
    events: new PassThrough({ objectMode: true }),
    inputUuid: randomUUID(),
    inputStarted: false,
    sawTerminalResult: false,
    foregroundTaskIds: new Set(),
    foregroundBashToolUseIds: new Set(),
    pendingBackgroundTaskIds: new Set(),
    subagentTaskIds: new Set(),
    taskNotifications: new Map(),
    steering: new Map(),
  };
  session.currentTurn = turn;
  const detachSteering =
    context.executionMode === "side-question"
      ? undefined
      : context.steering?.attach(createSteeringSink(session, turn));
  const abort = () => session.handle.close("abort", context.abortSignal?.reason);
  context.abortSignal?.addEventListener("abort", abort, { once: true });
  let startup: Promise<void> | undefined;
  try {
    // Consume startup records while initialization waits on the same stdout reader.
    startup = (async () => {
      context.abortSignal?.throwIfAborted();
      // Adopt the process's exact MCP capture before prompt dispatch or native tool callbacks.
      capability?.activate(session.handle);
      if (!session.transport) {
        const { args, excludeDynamicSections } = prepareClaudeCliTransportArgs(context);
        session.transport = createClaudeCliTransport({
          context,
          args,
          secretInput,
          currentContext: () => session.currentTurn?.context,
          initialize: {
            appendSystemPrompt: context.systemPrompt,
            // Native snapshots must not override the host's refreshed prompt on resume.
            systemPromptSnapshot: false,
            excludeDynamicSections,
            hooks: {
              UserPromptSubmit: [{ hookCallbackIds: [...CLAUDE_PROMPT_HOOK_CALLBACK_IDS] }],
              PreToolUse: [{ hookCallbackIds: ["PreToolUse"] }],
            },
          },
          onMessage: (message) => acceptMessage(session, message),
          onRequest: async (request, signal) => {
            // No interactive MCP elicitation handler is registered; preserve its declined outcome.
            if (request.subtype === "elicitation") {
              return () => ({ action: "decline" });
            }
            const admittedTurn = activeTurn(session);
            const response = await handleRequest(session, request, signal);
            // The transport invokes this synchronously at its final write, after all awaits.
            return () => {
              if (admittedTurn && activeTurn(session) === admittedTurn && !signal.aborted) {
                return response;
              }
              const message = "The OpenClaw run is no longer active.";
              if (request.subtype === "can_use_tool") {
                return { behavior: "deny", message, toolUseID: request.tool_use_id };
              }
              return request.callback_id === "PreToolUse"
                ? {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: message,
                    },
                  }
                : {};
            };
          },
          onError: (error) => session.handle.close("abort", error),
        });
        await session.transport.initialize();
      }
      context.assertCurrent?.();
      if (session.closed || session.currentTurn !== turn) {
        throw turn.error ?? new Error("Claude CLI closed before its prompt was accepted.");
      }
      await session.transport.send({
        type: "user",
        message: { role: "user", content: context.prompt },
        parent_tool_use_id: null,
        uuid: turn.inputUuid,
        ...(context.sessionId ? { session_id: context.sessionId } : {}),
      });
    })().catch((error: unknown) => session.handle.close("abort", error));
    for await (const record of turn.events) {
      yield record;
    }
    await startup;
    if (turn.error) {
      throw turn.error;
    }
    if (!turn.sawTerminalResult) {
      throw new Error("Claude CLI exited without a terminal result.");
    }
  } catch (error) {
    session.handle.close("abort", error);
    throw error;
  } finally {
    detachSteering?.();
    turn.controller.abort();
    context.abortSignal?.removeEventListener("abort", abort);
    // Iterator.return() is cancellation too; a partially consumed turn cannot stay warm.
    if (session.currentTurn === turn) {
      session.handle.close("abort");
    }
    await startup;
    if (session.closed) {
      await session.handle.waitForExit();
    }
  }
}
