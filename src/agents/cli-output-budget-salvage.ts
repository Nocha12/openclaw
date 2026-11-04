// Post-budget watcher for the Claude stream-json parser. Kept beside
// `cli-output-stream.ts` so the parser stays within the file-size budget.
//
// Once the cumulative turn budget (`maxTurnRawChars` / `maxTurnLines`) is
// spent, the parser stops assembling: no text, thinking, tool input or tool
// state is retained. The CLI still runs to completion, and its terminal
// `result` record carries the finished answer. Watching for that one record
// turns "reply lost" into "reply delivered, stream truncated" without lifting
// the memory bound. The per-line limit (`maxPendingLineChars`) stays fatal and
// still bounds every line seen here.
import type { CliBackendConfig } from "../plugins/cli-backend.types.js";
import type { CliOutput, CliUsage } from "./cli-output-contracts.js";
import {
  decodeCliRecords,
  isClaudeSubagentRecord,
  parseClaudeCliJsonlResult,
  readClaudeAttributedSubagentProgressId,
  readCliUsage,
} from "./cli-output-records.js";
import { appendCliResultText } from "./cli-output-results.js";

export type ClaudeBudgetSalvage = {
  /** Terminal output decoded from the `result` record. */
  result: CliOutput;
  /** The terminal record itself, for session id observation. */
  record: Record<string, unknown>;
  usage?: CliUsage;
};

/**
 * Inspect one raw line after the turn budget is spent. Retains nothing; only
 * dispatches attributed Agent progress (so a foreground Agent call keeps its
 * recovery clock) and returns the parent's terminal result once it arrives.
 */
export function observeClaudeLineAfterTurnBudget(params: {
  line: string;
  backend: CliBackendConfig;
  providerId: string;
  sessionId?: string;
  usage?: CliUsage;
  onAttributedSubagentProgress?: (parentToolUseId: string) => void;
}): ClaudeBudgetSalvage | undefined {
  // Cheap prefilter: only terminal results and child-attributed records matter.
  if (!params.line.includes('"result"') && !params.line.includes("parent_tool_use_id")) {
    return undefined;
  }
  for (const record of decodeCliRecords(params.line)) {
    const progressId = readClaudeAttributedSubagentProgressId(record);
    if (progressId) {
      params.onAttributedSubagentProgress?.(progressId);
      continue;
    }
    if (
      record.type !== "result" ||
      isClaudeSubagentRecord(record) ||
      record.openclaw_interim_result === true
    ) {
      continue;
    }
    const usage = readCliUsage(record);
    const result = parseClaudeCliJsonlResult({
      backend: params.backend,
      providerId: params.providerId,
      parsed: record,
      sessionId: params.sessionId,
      usage: usage ?? params.usage,
    });
    if (result) {
      return { result, record, ...(usage ? { usage } : {}) };
    }
  }
  return undefined;
}

/**
 * Output for a salvaged terminal result, or null when the turn stays failed.
 * Without the retained stream only the envelope is known, so an empty answer
 * keeps the original budget failure instead of passing as an empty success.
 */
export function resolveClaudeBudgetSalvageOutput(params: {
  salvage: ClaudeBudgetSalvage;
  previous: CliOutput | null;
  sessionId?: string;
  usage?: CliUsage;
}): CliOutput | null {
  const { result, usage: terminalUsage } = params.salvage;
  if (result.errorText) {
    return { ...result, sessionId: params.sessionId };
  }
  if (!result.text) {
    return null;
  }
  // Interim results committed before the budget ran out stay their own parts.
  const { text, textParts } = appendCliResultText(params.previous, result.text);
  // The resume checkpoint predates the spent budget, so it is not carried.
  return {
    ...result,
    sessionId: params.sessionId,
    text,
    ...(textParts.length > 1 ? { textParts } : {}),
    ...(params.usage && terminalUsage
      ? { usage: params.usage, diagnosticUsage: terminalUsage }
      : {}),
  };
}
