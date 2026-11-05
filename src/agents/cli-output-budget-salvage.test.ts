import { describe, expect, it } from "vitest";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

// A spent cumulative turn budget stops assembly but no longer discards the
// finished answer: the terminal result still decides the turn.

const RAW_BUDGET_ERROR = "CLI JSONL output exceeded 8388608 characters; refusing to parse output.";

function createClaudeParser(
  options: Partial<Parameters<typeof createCliJsonlStreamingParser>[0]> = {},
) {
  return createCliJsonlStreamingParser({
    backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
    providerId: "claude-cli",
    onAssistantDelta: () => {},
    ...options,
  });
}

const line = (record: unknown) => `${JSON.stringify(record)}\n`;

const assistantText = (id: string, text: string) =>
  line({ type: "assistant", message: { id, content: [{ type: "text", text }] } });

const terminalResult = (result: string, extra: Record<string, unknown> = {}) =>
  line({ type: "result", subtype: "success", result, session_id: "cli-session-1", ...extra });

/** Two retained 4.3 MB assistant snapshots spend the 8 MiB budget. */
function exhaustRawBudget(parser: ReturnType<typeof createClaudeParser>) {
  parser.push(assistantText("first", "a".repeat(4_300_000)));
  parser.push(assistantText("second", "b".repeat(4_300_000)));
}

describe("Claude CLI terminal result after a spent turn budget", () => {
  it("delivers the final answer and reports the truncation instead of failing", () => {
    const deltas: string[] = [];
    const parser = createClaudeParser({ onAssistantDelta: ({ delta }) => deltas.push(delta) });
    exhaustRawBudget(parser);
    const deltasAtExhaustion = deltas.length;
    parser.push(assistantText("third", "retained nothing after the budget"));
    parser.push(terminalResult("final answer"));
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getTruncationText()).toBe(RAW_BUDGET_ERROR);
    expect(parser.hasTerminalResult()).toBe(true);
    const output = parser.getOutput();
    expect(output?.text).toBe("final answer");
    expect(output?.errorText).toBeUndefined();
    expect(output?.sessionId).toBe("cli-session-1");
    // The checkpoint predates the spent budget and must not pin a stale resume point.
    expect(output?.resumeCheckpointId).toBeUndefined();
    expect(deltas).toHaveLength(deltasAtExhaustion);
  });

  it("delivers the final answer after the 20,000-frame budget", () => {
    const parser = createClaudeParser();
    const frame = line({ type: "system", subtype: "status", status: "working" });
    parser.push(frame.repeat(20_001));
    parser.push(terminalResult("done after many frames"));
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getTruncationText()).toContain("exceeded 20000 lines");
    expect(parser.getOutput()?.text).toBe("done after many frames");
  });

  it("keeps framing intact across the line that spent the budget", () => {
    const parser = createClaudeParser();
    parser.push(assistantText("first", "a".repeat(4_300_000)));
    const result = terminalResult("split answer");
    // The exhausting line and the start of the result share one chunk.
    parser.push(`${assistantText("second", "b".repeat(4_300_000))}${result.slice(0, 20)}`);
    parser.push(result.slice(20));
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()?.text).toBe("split answer");
  });

  it("accepts a terminal result without a trailing newline at finish", () => {
    const parser = createClaudeParser();
    exhaustRawBudget(parser);
    parser.push(terminalResult("tail answer").trimEnd());
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()?.text).toBe("tail answer");
  });

  it("keeps the original budget failure byte-identical when no result arrives", () => {
    const parser = createClaudeParser();
    exhaustRawBudget(parser);
    parser.finish();

    expect(parser.getErrorText()).toBe(RAW_BUDGET_ERROR);
    expect(parser.getTruncationText()).toBeNull();
    expect(parser.hasTerminalResult()).toBe(false);
    expect(parser.getOutput()).toMatchObject({ text: "", errorText: RAW_BUDGET_ERROR });
  });

  it("keeps the budget failure for an empty terminal answer", () => {
    const parser = createClaudeParser();
    exhaustRawBudget(parser);
    parser.push(terminalResult(""));
    parser.finish();

    expect(parser.getErrorText()).toBe(RAW_BUDGET_ERROR);
  });

  it("surfaces a terminal error result instead of the budget failure", () => {
    const parser = createClaudeParser();
    exhaustRawBudget(parser);
    parser.push(
      line({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "API Error: overloaded",
      }),
    );
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    const output = parser.getOutput();
    expect(output?.text).toBe("");
    expect(output?.errorText).toBeTruthy();
    expect(output?.errorText).not.toBe(RAW_BUDGET_ERROR);
  });

  it("ignores subagent results but keeps Agent progress alive", () => {
    const progress: string[] = [];
    const parser = createClaudeParser({
      onAttributedSubagentProgress: (id) => progress.push(id),
    });
    exhaustRawBudget(parser);
    parser.push(terminalResult("child answer", { parent_tool_use_id: "agent-1" }));
    parser.push(
      line({
        type: "assistant",
        parent_tool_use_id: "agent-1",
        message: { id: "child", content: [{ type: "text", text: "working" }] },
      }),
    );
    expect(parser.getErrorText()).toBe(RAW_BUDGET_ERROR);
    expect(progress).toEqual(["agent-1"]);

    parser.push(terminalResult("parent answer"));
    parser.finish();
    expect(parser.getOutput()?.text).toBe("parent answer");
  });

  it("salvages a terminal result that is itself the line spending the budget", () => {
    const parser = createClaudeParser();
    parser.push(assistantText("first", "a".repeat(8_000_000)));
    parser.push(terminalResult(`answer ${"z".repeat(400_000)}`));
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getTruncationText()).toBe(RAW_BUDGET_ERROR);
    expect(parser.getOutput()?.text.startsWith("answer zzz")).toBe(true);
  });

  it("salvages a terminal result that is the 20,001st frame", () => {
    const parser = createClaudeParser();
    parser.push(line({ type: "system", subtype: "status", status: "working" }).repeat(20_000));
    parser.push(terminalResult("last frame answer"));
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()?.text).toBe("last frame answer");
  });

  it("settles started tool calls after the budget without starting new ones", () => {
    const starts: string[] = [];
    const results: string[] = [];
    const parser = createClaudeParser({
      onToolUseStart: (start) => starts.push(start.toolCallId),
      onToolResult: (result) => results.push(result.toolCallId),
    });
    const toolUse = (id: string) =>
      line({
        type: "assistant",
        message: {
          id: `call-${id}`,
          content: [{ type: "tool_use", id, name: "Agent", input: {} }],
        },
      });
    const toolResult = (id: string) =>
      line({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
      });
    parser.push(toolUse("agent-1"));
    exhaustRawBudget(parser);
    parser.push(toolResult("agent-1"));
    parser.push(toolResult("agent-1"));
    parser.push(toolUse("late-1"));
    parser.push(toolResult("late-1"));
    parser.push(terminalResult("done"));
    parser.finish();

    expect(starts).toEqual(["agent-1"]);
    expect(results).toEqual(["agent-1"]);
    expect(parser.getOutput()?.text).toBe("done");
  });

  it("commits interim results that arrive after the budget", () => {
    const completed: string[] = [];
    const parser = createClaudeParser({ onCompletedReply: (text) => completed.push(text) });
    exhaustRawBudget(parser);
    parser.push(terminalResult("analysis delivered", { openclaw_interim_result: true }));
    expect(completed).toEqual(["analysis delivered"]);
    expect(parser.getErrorText()).toBe(RAW_BUDGET_ERROR);

    parser.push(terminalResult("background finished"));
    parser.finish();
    const output = parser.getOutput();
    expect(output?.text).toBe("analysis delivered\nbackground finished");
    expect(output?.textParts).toEqual(["analysis delivered", "background finished"]);
  });

  it("lets a later terminal result decide after an interim error", () => {
    const parser = createClaudeParser();
    exhaustRawBudget(parser);
    parser.push(
      terminalResult("API Error: interim", {
        openclaw_interim_result: true,
        subtype: "error_during_execution",
        is_error: true,
      }),
    );
    parser.push(terminalResult("recovered answer"));
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()?.text).toBe("recovered answer");
  });

  it("strips leading tagged reasoning from a salvaged answer", () => {
    const parser = createClaudeParser();
    exhaustRawBudget(parser);
    parser.push(terminalResult("<think>private plan</think>\nvisible answer"));
    parser.finish();

    expect(parser.getOutput()?.text).toBe("visible answer");
  });

  it("keeps parent usage current after the budget", () => {
    const parser = createClaudeParser();
    exhaustRawBudget(parser);
    parser.push(
      line({
        type: "assistant",
        message: {
          id: "late",
          content: [{ type: "text", text: "x" }],
          usage: { input_tokens: 180_000, output_tokens: 10 },
        },
      }),
    );
    parser.push(terminalResult("done", { usage: { input_tokens: 1, output_tokens: 1 } }));
    parser.finish();

    const output = parser.getOutput();
    expect(output?.usage?.input).toBe(180_000);
    expect(output?.diagnosticUsage?.input).toBe(1);
  });

  it("keeps the retryable budget failure for a stopped turn", () => {
    const parser = createClaudeParser();
    exhaustRawBudget(parser);
    parser.push(
      line({
        type: "result",
        subtype: "success",
        result: "",
        terminal_reason: "hook_stopped",
        stop_reason: "tool_use",
      }),
    );
    parser.finish();

    expect(parser.getErrorText()).toBe(RAW_BUDGET_ERROR);
  });

  it("keeps interim parts committed before the budget ran out", () => {
    const parser = createClaudeParser();
    parser.push(assistantText("early", "early reply"));
    parser.push(terminalResult("early reply", { openclaw_interim_result: true }));
    exhaustRawBudget(parser);
    parser.push(terminalResult("late reply"));
    parser.finish();

    const output = parser.getOutput();
    expect(output?.text).toBe("early reply\nlate reply");
    expect(output?.textParts).toEqual(["early reply", "late reply"]);
  });

  it("uses only the first terminal result", () => {
    const parser = createClaudeParser();
    exhaustRawBudget(parser);
    parser.push(terminalResult("first answer"));
    parser.push(terminalResult("second answer"));
    parser.finish();

    expect(parser.getOutput()?.text).toBe("first answer");
  });

  it("keeps the single-line limit fatal even when a result follows", () => {
    const parser = createClaudeParser();
    exhaustRawBudget(parser);
    parser.push(line({ type: "user", note: "x".repeat(8 * 1024 * 1024 + 1) }));
    parser.push(terminalResult("never seen"));
    parser.finish();

    expect(parser.getErrorText()).toContain("JSONL line exceeded 8388608 characters");
    expect(parser.getTruncationText()).toBeNull();
    expect(parser.getOutput()?.text).toBe("");
  });

  it("does not watch for results on non-Claude JSONL dialects", () => {
    const parser = createCliJsonlStreamingParser({
      backend: { command: "other", output: "jsonl" },
      providerId: "other-cli",
      onAssistantDelta: () => {},
    });
    parser.push("x".repeat(4_300_000));
    parser.push(`${"y".repeat(4_300_000)}\n`);
    parser.push(terminalResult("ignored"));
    parser.finish();

    expect(parser.getErrorText()).toContain("exceeded 8388608 characters");
    expect(parser.getTruncationText()).toBeNull();
  });

  it("keeps backend validation and lifecycle events after the budget", () => {
    const compactions: unknown[] = [];
    const parser = createClaudeParser({
      // Shaped like the Claude backend: lifecycle lines and rejected raw tool protocol.
      parseJsonlLifecycleEvent: (raw) =>
        raw.includes("compact_result")
          ? { kind: "compaction", phase: "end", completed: true }
          : null,
      parseJsonlEvent: (raw) =>
        raw.includes("<invoke") ? { kind: "result", errorText: "raw tool protocol" } : null,
      onCompaction: (delta) => compactions.push(delta),
    });
    exhaustRawBudget(parser);
    parser.push(line({ type: "system", subtype: "compact_boundary", compact_result: "success" }));
    parser.push(terminalResult('<invoke name="Bash"><parameter name="command">ls</parameter>'));
    parser.push(terminalResult("must not replace the rejected result"));
    parser.finish();

    expect(compactions).toEqual([{ phase: "end", completed: true }]);
    expect(parser.getErrorText()).toBeNull();
    expect(parser.getTruncationText()).toBeNull();
    expect(parser.getOutput()?.errorText).toBe("raw tool protocol");
  });

  it("keeps a rejected result that is itself the 20,001st frame", () => {
    const parser = createClaudeParser({
      parseJsonlEvent: (raw) =>
        raw.includes("<invoke") ? { kind: "result", errorText: "raw tool protocol" } : null,
    });
    parser.push(line({ type: "system", subtype: "status", status: "working" }).repeat(20_000));
    parser.push(terminalResult('<invoke name="Bash"><parameter name="command">ls</parameter>'));
    parser.push(terminalResult("must not replace the rejected result"));
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getTruncationText()).toBeNull();
    expect(parser.getOutput()?.errorText).toBe("raw tool protocol");
  });

  it("keeps the budget failure once results after it outgrow the retention bound", () => {
    const completed: string[] = [];
    const parser = createClaudeParser({ onCompletedReply: (text) => completed.push(text) });
    exhaustRawBudget(parser);
    for (const fill of ["c", "d", "e"]) {
      parser.push(terminalResult(fill.repeat(3_000_000), { openclaw_interim_result: true }));
    }
    parser.push(terminalResult("final answer"));
    parser.finish();

    // Parts within the bound were still delivered as they arrived.
    expect(completed).toHaveLength(2);
    expect(parser.getErrorText()).toBe(RAW_BUDGET_ERROR);
    expect(parser.getOutput()?.text).toBe("");
  });
});

describe("Claude CLI turns with many large image tool results", () => {
  // Shape of the 2026-11-04 subagent failures: 1920x1080 screenshots read with
  // `Read`, each echoed in the message copy and in `tool_use_result` (~1.08 MB).
  const screenshot = "A".repeat(540_000);
  const readResult = (index: number, echo: unknown) =>
    line({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: `read-${index}`,
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: screenshot },
              },
            ],
          },
        ],
      },
      tool_use_result: echo,
    });

  it.each([
    ["built-in Read echo", { type: "image", file: { base64: screenshot, type: "image/png" } }],
    // An echo shape the media normalizer does not recognize is still discounted.
    ["unrecognized echo", { kind: "screenshot", payload: { encoded: screenshot } }],
  ] as const)("keeps the final reply after 40 screenshots with a %s", (_name, echo) => {
    const parser = createClaudeParser();
    for (let index = 0; index < 40; index += 1) {
      parser.push(
        line({
          type: "assistant",
          message: {
            id: `call-${index}`,
            content: [{ type: "tool_use", id: `read-${index}`, name: "Read", input: {} }],
          },
        }),
      );
      parser.push(readResult(index, echo));
    }
    parser.push(assistantText("final", "report written"));
    parser.push(terminalResult("report written"));
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getTruncationText()).toBeNull();
    expect(parser.getOutput()?.text).toBe("report written");
  });
});
