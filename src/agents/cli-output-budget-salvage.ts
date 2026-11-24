import type { CliBackendParsedJsonlEvent } from "../plugins/cli-backend.types.js";
import type { CliJsonlStreamingParserOptions, CliOutput, CliUsage } from "./cli-output-contracts.js";
import type { createToolUseTracker } from "./cli-output-events.js";
import { partitionLeadingTaggedReasoning, settleClaudeStartedToolResults } from "./cli-output-events.js";
import {
  isClaudeSubagentRecord,
  parseClaudeCliJsonlResult,
  pickCliSessionId,
  readClaudeAttributedSubagentProgressId,
  readCliUsage,
} from "./cli-output-records.js";
import { appendCliResultText, withCliRawFinalText } from "./cli-output-results.js";
import {
  CLI_STREAM_JSON_OUTPUT_LIMITS,
  streamJsonOutputLimitErrorText,
} from "./cli-output-stream-limits.js";

export function createClaudeTurnBudgetWatch(params: {
  options: CliJsonlStreamingParserOptions;
  tracker: ReturnType<typeof createToolUseTracker>;
  observeSessionId: (id: string | undefined) => string | undefined;
}) {
  const { options, tracker, observeSessionId } = params;
  const { maxTurnLines, maxTurnRawChars } = CLI_STREAM_JSON_OUTPUT_LIMITS;
  let rawChars = 0;
  let countedFrames = 0;
  let errorText = "";
  let terminalOutput: CliOutput | null = null;
  let exhausted = false;
  let sawToolActivity = false;

  return {
    get errorText() {
      return errorText;
    },
    get terminalOutput() {
      return terminalOutput;
    },
    get sawToolActivity() {
      return sawToolActivity;
    },
    account(lineChars: number, countsFrame = false) {
      if (!errorText) {
        if (countsFrame && ++countedFrames > maxTurnLines) {
          errorText = streamJsonOutputLimitErrorText("lines", maxTurnLines);
        } else if ((rawChars += lineChars + 1) > maxTurnRawChars) {
          errorText = streamJsonOutputLimitErrorText("raw", maxTurnRawChars);
        }
      }
      return !errorText;
    },
    truncationText(parseErrorText: string) {
      return terminalOutput && !terminalOutput.errorText && !parseErrorText ? errorText : null;
    },
    settleBackendEvent(event: CliBackendParsedJsonlEvent, usage?: CliUsage) {
      sawToolActivity ||= event.kind === "toolStart" || event.kind === "toolResult";
      if (terminalOutput || event.kind !== "result" || !event.errorText) {
        return;
      }
      const sessionId = observeSessionId(event.sessionId?.trim());
      if (event.usage) {
        options.onUsage?.(event.usage, true);
      }
      terminalOutput = {
        text: "",
        errorText: event.errorText,
        sessionId,
        usage: event.usage ?? usage,
      };
    },
    observe(
      records: Record<string, unknown>[],
      state: { output: CliOutput | null; usage?: CliUsage },
    ) {
      if (terminalOutput) {
        return state;
      }
      let { output, usage } = state;
      for (const record of records) {
        const progressId = readClaudeAttributedSubagentProgressId(record);
        if (progressId) {
          options.onAttributedSubagentProgress?.(progressId);
        }
        if (isClaudeSubagentRecord(record)) {
          continue;
        }
        const sawTool = settleClaudeStartedToolResults({
          parsed: record,
          tracker,
          onToolResult: options.onToolResult,
        });
        sawToolActivity ||= sawTool;
        const recordUsage = readCliUsage(record);
        if (record.type !== "result") {
          if (record.type === "assistant" && recordUsage) {
            usage = recordUsage;
            options.onUsage?.(recordUsage, false);
          }
          continue;
        }
        const result = parseClaudeCliJsonlResult({
          backend: options.backend,
          providerId: options.providerId,
          parsed: record,
          usage: recordUsage ?? usage,
        });
        if (!result) {
          continue;
        }
        const sessionId = observeSessionId(pickCliSessionId(record, options.backend));
        const interim = record.openclaw_interim_result === true;
        if (recordUsage) {
          options.onUsage?.(recordUsage, !interim);
        }
        if (result.terminalFailure?.reason === "turn_stopped" || exhausted) {
          break;
        }
        if (result.errorText) {
          const next = { ...result, sessionId };
          if (interim) {
            output = next;
          } else {
            terminalOutput = next;
          }
          break;
        }
        const tagged = partitionLeadingTaggedReasoning(result.text, true);
        const answer = !tagged.pending && tagged.reasoningText ? tagged.visibleText.trim() : result.text;
        if (!answer) {
          break;
        }
        const { text, textParts, completedText } = appendCliResultText(output, answer);
        if (text.length > maxTurnRawChars || textParts.length > maxTurnLines) {
          exhausted = true;
          break;
        }
        const next = {
          ...withCliRawFinalText({ ...result, sessionId, text }, answer),
          ...(textParts.length > 1 || interim || output?.textParts ? { textParts } : {}),
          ...(usage && recordUsage ? { usage, diagnosticUsage: recordUsage } : {}),
        };
        if (interim) {
          output = next;
          if (completedText) {
            options.onCompletedReply?.(completedText, textParts.length - 1);
          }
        } else {
          terminalOutput = next;
        }
        break;
      }
      return { output, usage };
    },
  };
}
