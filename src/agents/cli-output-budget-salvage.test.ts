import { describe, expect, it } from "vitest";
import { CLI_STREAM_JSON_OUTPUT_LIMITS } from "./cli-output-stream-limits.js";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

const { maxTurnLines, maxTurnRawChars, maxPendingLineChars } = CLI_STREAM_JSON_OUTPUT_LIMITS;
const rawBudgetError = `CLI JSONL output exceeded ${maxTurnRawChars} characters; refusing to parse output.`;

function createParser(options: Partial<Parameters<typeof createCliJsonlStreamingParser>[0]> = {}) {
  return createCliJsonlStreamingParser({
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    providerId: "claude-cli",
    onAssistantDelta: () => {},
    ...options,
  });
}

const line = (record: unknown) => `${JSON.stringify(record)}\n`;
const assistant = (id: string, ...content: unknown[]) =>
  line({ type: "assistant", message: { id, content } });
const snapshot = (id: string, text: string) => assistant(id, { type: "text", text });
const result = (text: string, extra: Record<string, unknown> = {}) =>
  line({ type: "result", subtype: "success", result: text, session_id: "native", ...extra });
const toolResult = (id: string, content: string) =>
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });

function spendRawBudget(parser: ReturnType<typeof createParser>) {
  parser.push(snapshot("first", "a".repeat(4_300_000)));
  parser.push(snapshot("over-budget", "b".repeat(4_300_000)));
}

describe("Claude CLI terminal result after a spent turn budget", () => {
  it("delivers the answer without emitting more partial text or retaining a stale checkpoint", () => {
    const deltas: string[] = [];
    const parser = createParser({ onAssistantDelta: ({ delta }) => deltas.push(delta) });
    parser.push(line({ type: "system", subtype: "resume_checkpoint", resume_at: "old" }));
    spendRawBudget(parser);
    const deltasAtExhaustion = deltas.length;
    parser.push(snapshot("later", "not retained"));
    parser.push(result("final answer"));
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getTruncationText()).toBe(rawBudgetError);
    expect(parser.hasTerminalResult()).toBe(true);
    expect(parser.getOutput()).toMatchObject({ text: "final answer", sessionId: "native" });
    expect(parser.getOutput()?.resumeCheckpointId).toBeUndefined();
    expect(deltas).toHaveLength(deltasAtExhaustion);
  });

  it.each(["after", "same line", "rejected on same line"])(
    "observes a terminal result %s as the discounted-frame budget is spent",
    (timing) => {
      const parser = createParser({
        parseJsonlEvent: (raw) =>
          raw.includes("rejected payload") ? { kind: "result", errorText: "backend rejected" } : null,
      });
      const padding = " ".repeat(1_100);
      parser.push(toolResult("discarded", "x".repeat(1_100)).repeat(maxTurnLines));
      if (timing === "after") {
        parser.push(toolResult("discarded", "x".repeat(1_100)));
      }
      const rejected = timing === "rejected on same line";
      const terminal = result(rejected ? "rejected payload" : "done").trimEnd();
      // Unrecognized result records and custom events both charge their full line;
      // let the raw threshold be crossed by the same record for the ordinary path.
      if (timing !== "after") {
        const filler = "x".repeat(4_300_000);
        parser.push(snapshot("retained", filler));
        const hugeResult = result(rejected ? "rejected payload" : filler).trimEnd();
        parser.push(`${hugeResult}${rejected ? padding.repeat(4_000) : ""}\n`);
      } else {
        parser.push(`${terminal}\n`);
      }
      parser.push(result("must not replace the first settled result"));
      parser.finish();

      expect(parser.getErrorText()).toBeNull();
      if (rejected) {
        expect(parser.getTruncationText()).toBeNull();
        expect(parser.getOutput()?.errorText).toBe("backend rejected");
      } else {
        expect(parser.getTruncationText()).toContain(
          timing === "after" ? `exceeded ${maxTurnLines} lines` : `exceeded ${maxTurnRawChars} characters`,
        );
        expect(parser.getOutput()?.text).toBe(
          timing === "after" ? "done" : "x".repeat(4_300_000),
        );
      }
    },
  );

  it("keeps framing across chunks and reads an unterminated terminal result", () => {
    const parser = createParser();
    const terminal = result("split answer").trimEnd();
    parser.push(snapshot("first", "a".repeat(4_300_000)));
    parser.push(`${snapshot("second", "b".repeat(4_300_000))}${terminal.slice(0, 20)}`);
    parser.push(terminal.slice(20));
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()?.text).toBe("split answer");
  });

  it.each([
    ["no result", ""],
    ["empty result", result("")],
    ["stopped result", result("", { terminal_reason: "max_turns" })],
  ])("keeps the original budget error for %s", (_name, terminal) => {
    const parser = createParser();
    spendRawBudget(parser);
    expect(parser.getFatalErrorText()).toBeNull();
    parser.push(terminal);
    parser.finish();

    expect(parser.getErrorText()).toBe(rawBudgetError);
    expect(parser.getTruncationText()).toBeNull();
    expect(parser.hasTerminalResult()).toBe(false);
    expect(parser.getOutput()).toMatchObject({ text: "", errorText: rawBudgetError });
  });

  it("reports the CLI terminal error rather than the budget error", () => {
    const parser = createParser();
    spendRawBudget(parser);
    parser.push(result("API Error: overloaded", { subtype: "error_during_execution", is_error: true }));
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()).toMatchObject({ text: "", errorText: expect.stringContaining("overloaded") });
  });

  it("ignores child results, observes child progress and settles only previously started tools", () => {
    const started: string[] = [];
    const settled: string[] = [];
    const progress: string[] = [];
    const parser = createParser({
      onToolUseStart: ({ toolCallId }) => started.push(toolCallId),
      onToolResult: ({ toolCallId }) => settled.push(toolCallId),
      onAttributedSubagentProgress: (id) => progress.push(id),
    });
    parser.push(assistant("call", { type: "tool_use", id: "agent", name: "Agent", input: {} }));
    spendRawBudget(parser);
    parser.push(result("child only", { parent_tool_use_id: "agent" }));
    expect(parser.hasTerminalResult()).toBe(false);
    expect(parser.getErrorText()).toBe(rawBudgetError);
    parser.push(assistant("ignored-call", { type: "tool_use", id: "new", name: "Read", input: {} }));
    parser.push(toolResult("new", "ignored"));
    parser.push(toolResult("agent", "done"));
    parser.push(toolResult("agent", "replayed"));
    parser.finish();

    expect(started).toEqual(["agent"]);
    expect(settled).toEqual(["agent"]);
    expect(progress).toContain("agent");
  });

  it("retains interim parts before and after the budget, with a later clean terminal verdict", () => {
    const completed: Array<[string, number]> = [];
    const parser = createParser({ onCompletedReply: (text, index) => completed.push([text, index]) });
    parser.push(result("early reply", { openclaw_interim_result: true }));
    spendRawBudget(parser);
    parser.push(result("late part", { openclaw_interim_result: true }));
    parser.push(result("<thinking>not an answer</thinking>late reply"));
    parser.finish();

    expect(completed).toEqual([["early reply", 0], ["late part", 1]]);
    expect(parser.getOutput()).toMatchObject({
      text: "early reply\nlate part\nlate reply",
      textParts: ["early reply", "late part", "late reply"],
      rawFinalText: "late reply",
    });
  });

  it("does not settle on an interim error and preserves parent and terminal usage separately", () => {
    const usageEvents: Array<[number | undefined, boolean]> = [];
    const parser = createParser({
      onUsage: (usage, terminal) => usageEvents.push([usage.input, terminal]),
    });
    spendRawBudget(parser);
    parser.push(line({ type: "assistant", message: { content: [], usage: { input_tokens: 17 } } }));
    parser.push(result("temporary error", { is_error: true, openclaw_interim_result: true }));
    expect(parser.getErrorText()).toBe(rawBudgetError);
    parser.push(result("later answer", { usage: { input_tokens: 99 } }));
    parser.finish();

    expect(usageEvents).toContainEqual([17, false]);
    expect(usageEvents).toContainEqual([99, true]);
    expect(parser.getOutput()).toMatchObject({
      text: "later answer",
      usage: { inputTokens: 17 },
      diagnosticUsage: { inputTokens: 99 },
    });
  });

  it("keeps backend lifecycle and rejection active after the budget", () => {
    const compactions: unknown[] = [];
    const parser = createParser({
      parseJsonlLifecycleEvent: (raw) =>
        raw.includes("compact_boundary")
          ? { kind: "compaction", phase: "end", completed: true, tokensBefore: 20 }
          : null,
      parseJsonlEvent: (raw) =>
        raw.includes("invalid envelope") ? { kind: "result", errorText: "backend rejected" } : null,
      onCompaction: (delta) => compactions.push(delta),
    });
    spendRawBudget(parser);
    parser.push(line({ type: "system", subtype: "compact_boundary" }));
    parser.push(result("invalid envelope"));
    parser.push(result("must not outrank rejection"));
    parser.finish();

    expect(compactions).toEqual([{ phase: "end", completed: true, tokensBefore: 20 }]);
    expect(parser.getErrorText()).toBeNull();
    expect(parser.getTruncationText()).toBeNull();
    expect(parser.getOutput()?.errorText).toBe("backend rejected");
  });

  it("keeps the budget failure if interim results outgrow the retention bound", () => {
    const completed: string[] = [];
    const parser = createParser({ onCompletedReply: (text) => completed.push(text) });
    spendRawBudget(parser);
    for (const fill of ["c", "d", "e"]) {
      parser.push(result(fill.repeat(3_000_000), { openclaw_interim_result: true }));
    }
    parser.push(result("late answer"));
    parser.finish();

    expect(completed).toHaveLength(2);
    expect(parser.getErrorText()).toBe(rawBudgetError);
    expect(parser.getOutput()?.text).toBe("");
  });

  it("keeps the single-line limit fatal even when a result follows it", () => {
    const parser = createParser();
    spendRawBudget(parser);
    parser.push(`${"a".repeat(maxPendingLineChars + 1)}\n${result("never seen")}`);
    parser.finish();

    expect(parser.getFatalErrorText()).toContain(`JSONL line exceeded ${maxPendingLineChars}`);
    expect(parser.getTruncationText()).toBeNull();
    expect(parser.getOutput()?.text).toBe("");
  });

  it("does not wait for results on non-Claude JSONL dialects", () => {
    const parser = createParser({ backend: { command: "other", output: "jsonl" }, providerId: "other" });
    parser.push("x".repeat(4_300_000));
    parser.push(`${"y".repeat(4_300_000)}\n`);
    parser.push(result("ignored"));
    parser.finish();

    expect(parser.getFatalErrorText()).toBe(rawBudgetError);
    expect(parser.getTruncationText()).toBeNull();
  });
});
