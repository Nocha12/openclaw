// Post-budget watcher for the Claude stream-json parser. Kept beside
// `cli-output-stream.ts` so the parser stays within the file-size budget.
//
// Once the cumulative turn budget (`maxTurnRawChars` / `maxTurnLines`) is
// spent, the parser stops assembling: no text, thinking or tool input is
// retained. The CLI still runs to completion, and its terminal `result` record
// carries the finished answer. Watching for the records that still decide the
// outcome turns "reply lost" into "reply delivered, stream truncated" without
// lifting the memory bound. The per-line limit (`maxPendingLineChars`) stays
// fatal and still bounds every line seen here.
import type { CliBackendConfig } from "../plugins/cli-backend.types.js";
import type {
  CliJsonlStreamingParserOptions,
  CliOutput,
  CliToolResultDelta,
  CliUsage,
} from "./cli-output-contracts.js";
import type { createToolUseTracker } from "./cli-output-events.js";
import {
  partitionLeadingTaggedReasoning,
  settleClaudeStartedToolResults,
} from "./cli-output-events.js";
import {
  decodeCliRecords,
  isClaudeSubagentRecord,
  parseClaudeCliJsonlResult,
  readClaudeAttributedSubagentProgressId,
  readCliUsage,
} from "./cli-output-records.js";
import { appendCliResultText } from "./cli-output-results.js";

export type ClaudeBudgetResult = {
  /** Terminal output decoded from the `result` record. */
  result: CliOutput;
  /** The result record itself, for session id observation. */
  record: Record<string, unknown>;
  /** An OpenClaw interim result commits a part; the turn continues. */
  interim: boolean;
  usage?: CliUsage;
};

/**
 * Inspect one line after the turn budget is spent. Retains nothing. Dispatches
 * attributed Agent progress and settles already-started tool calls (so the
 * blocked-tool clock keeps moving), reports parent usage, and returns parent
 * result records.
 */
export function observeClaudeLineAfterTurnBudget(params: {
  line: string;
  backend: CliBackendConfig;
  providerId: string;
  sessionId?: string;
  usage?: CliUsage;
  tracker: ReturnType<typeof createToolUseTracker>;
  onToolResult?: (delta: CliToolResultDelta) => void;
  onAttributedSubagentProgress?: (parentToolUseId: string) => void;
  onParentUsage: (usage: CliUsage) => void;
}): ClaudeBudgetResult | undefined {
  // Parent partial frames are the bulk of a long stream and decide nothing here.
  if (
    params.line.startsWith('{"type":"stream_event"') &&
    !params.line.includes('"parent_tool_use_id":"')
  ) {
    return undefined;
  }
  for (const record of decodeCliRecords(params.line)) {
    const progressId = readClaudeAttributedSubagentProgressId(record);
    if (progressId) {
      params.onAttributedSubagentProgress?.(progressId);
    }
    if (isClaudeSubagentRecord(record)) {
      continue;
    }
    settleClaudeStartedToolResults({
      parsed: record,
      tracker: params.tracker,
      onToolResult: params.onToolResult,
    });
    const usage = readCliUsage(record);
    if (record.type !== "result") {
      if (usage && record.type === "assistant") {
        params.onParentUsage(usage);
      }
      continue;
    }
    const result = parseClaudeCliJsonlResult({
      backend: params.backend,
      providerId: params.providerId,
      parsed: record,
      sessionId: params.sessionId,
      usage: usage ?? params.usage,
    });
    if (result) {
      return {
        result,
        record,
        interim: record.openclaw_interim_result === true,
        ...(usage ? { usage } : {}),
      };
    }
  }
  return undefined;
}

/**
 * Output for a result seen after the budget, or null when the turn stays
 * failed. Without the retained stream only the envelope is known, so an empty
 * answer, or a stopped turn whose streamed text is gone, keeps the original
 * budget failure instead of passing as an empty success or a non-retryable stop.
 */
export function resolveClaudeBudgetSalvageOutput(params: {
  salvage: ClaudeBudgetResult;
  previous: CliOutput | null;
  sessionId?: string;
  usage?: CliUsage;
}): (CliOutput & { completedText: string }) | null {
  const { result, usage: terminalUsage } = params.salvage;
  if (result.terminalFailure?.reason === "turn_stopped") {
    return null;
  }
  if (result.errorText) {
    return { ...result, sessionId: params.sessionId, completedText: "" };
  }
  const tagged = partitionLeadingTaggedReasoning(result.text, true);
  const answer =
    !tagged.pending && tagged.reasoningText ? tagged.visibleText.trim() : result.text;
  if (!answer) {
    return null;
  }
  // Interim results stay their own parts, before or after the budget ran out.
  const { text, textParts, completedText } = appendCliResultText(params.previous, answer);
  // The resume checkpoint predates the spent budget, so it is not carried.
  return {
    ...result,
    sessionId: params.sessionId,
    text,
    completedText,
    ...(textParts.length > 1 || params.salvage.interim || params.previous?.textParts
      ? { textParts }
      : {}),
    ...(params.usage && terminalUsage
      ? { usage: params.usage, diagnosticUsage: terminalUsage }
      : {}),
  };
}

/** Parser state a post-budget line may advance; mutated in place. */
export type ClaudeBudgetWatchState = {
  output: CliOutput | null;
  usage?: CliUsage;
  /** Terminal output once a parent result arrived after the budget. */
  salvage: CliOutput | null;
};

/** Advance parser state with one line seen after the turn budget is spent. */
export function watchClaudeLineAfterTurnBudget(params: {
  line: string;
  options: CliJsonlStreamingParserOptions;
  tracker: ReturnType<typeof createToolUseTracker>;
  state: ClaudeBudgetWatchState;
  /** Records the result's session id and returns the current one. */
  observeSessionId: (record: Record<string, unknown>) => string | undefined;
}): void {
  const { options, state } = params;
  if (state.salvage) {
    return;
  }
  const salvage = observeClaudeLineAfterTurnBudget({
    ...options,
    line: params.line,
    usage: state.usage,
    tracker: params.tracker,
    onParentUsage: (usage) => {
      state.usage = usage;
      options.onUsage?.(usage, false);
    },
  });
  if (!salvage) {
    return;
  }
  const sessionId = params.observeSessionId(salvage.record);
  if (salvage.usage) {
    options.onUsage?.(salvage.usage, !salvage.interim);
  }
  const resolved = resolveClaudeBudgetSalvageOutput({
    salvage,
    previous: state.output,
    sessionId,
    usage: state.usage,
  });
  if (!resolved) {
    return;
  }
  const { completedText, ...next } = resolved;
  if (!salvage.interim) {
    state.salvage = next;
    return;
  }
  // Like the normal path, an interim error is recorded and a later result still decides.
  state.output = next;
  if (completedText && !next.errorText) {
    options.onCompletedReply?.(completedText, (next.textParts?.length ?? 1) - 1);
  }
}
