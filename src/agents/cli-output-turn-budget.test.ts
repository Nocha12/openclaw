import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { describe, expect, it } from "vitest";
import type { CliToolResultDelta } from "./cli-output-contracts.js";
import { chargeClaudeStreamJsonLine } from "./cli-output-stream-limits.js";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

// Backport of upstream #184352, #186085 and #166127: the per-turn 8 MiB budget
// charges only what the parser retains, so long tool-heavy turns keep their reply.

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

function toolResultFrame(id: string, content: unknown, extra: Record<string, unknown> = {}) {
  return {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
    ...extra,
  };
}

function numericToolResultLine(id: string, padding = "") {
  return (
    JSON.stringify(
      toolResultFrame(id, [], { tool_use_result: Array(200_000).fill(1e20) }),
    ).replaceAll("100000000000000000000", "1e20") + padding
  );
}

const line = (record: unknown) => `${JSON.stringify(record)}\n`;

describe("Claude CLI turn budget for discarded tool results", () => {
  it("keeps the final reply after a long browser-snapshot style turn beyond 8 MiB", () => {
    // Shape of the 2026-11-04 failure: many large text tool results, each echoed in
    // tool_use_result, totalling about 24 MiB of stdout in one turn.
    const results: CliToolResultDelta[] = [];
    const parser = createClaudeParser({ onToolResult: (result) => results.push(result) });
    const snapshot = "row ".repeat(100_000);
    for (let index = 0; index < 30; index += 1) {
      const tool = { type: "tool_use", id: `snap-${index}`, name: "browser", input: {} };
      parser.push(line({ type: "assistant", message: { id: `call-${index}`, content: [tool] } }));
      const content = [{ type: "text", text: snapshot }];
      parser.push(line(toolResultFrame(tool.id, content, { tool_use_result: content })));
    }
    parser.push(
      line({
        type: "assistant",
        message: { id: "final", content: [{ type: "text", text: "done" }] },
      }),
    );
    parser.push(line({ type: "result", subtype: "success", result: "done" }));
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()?.text).toBe("done");
    expect(results).toHaveLength(30);
    expect(results.every((result) => JSON.stringify(result.result).includes("row row"))).toBe(true);
  });

  it.each(["media", "text"] as const)(
    "delivers repeated %s tool results without losing the final reply",
    (kind) => {
      const results: CliToolResultDelta[] = [];
      const parser = createClaudeParser({ onToolResult: (result) => results.push(result) });
      const data = "A".repeat(600_000);
      const text = kind === "media" ? "Cursor Position: (1, 2)" : "x".repeat(120_000);
      const content = [
        { type: "text", text },
        ...(kind === "media"
          ? [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }]
          : []),
      ];
      for (let index = 0; index < 40; index += 1) {
        parser.push(
          line(toolResultFrame(`result-${index}`, content, { tool_use_result: content })),
        );
      }
      parser.push(line({ type: "result", result: "done" }));
      parser.finish();
      expect(parser.getErrorText()).toBeNull();
      expect(parser.getOutput()?.text).toBe("done");
      const expected = [
        { type: "text", text },
        ...(kind === "media"
          ? [
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg" },
                omitted: true,
                bytes: estimateBase64DecodedBytes(data),
              },
            ]
          : []),
      ];
      expect(results.map((result) => result.result)).toEqual(
        Array.from({ length: 40 }, () => expected),
      );
    },
  );

  it.each([
    {
      name: "tool-result IDs with short numeric wire literals",
      createLine: () => numericToolResultLine("i".repeat(4_300_000)),
    },
    {
      name: "tool-result padding with short numeric wire literals",
      createLine: () => numericToolResultLine("padded", " ".repeat(4_300_000)),
    },
    {
      name: "unknown tool-result metadata",
      createLine: () =>
        JSON.stringify(toolResultFrame("metadata", [], { extra: "x".repeat(4_300_000) })),
    },
    {
      name: "mixed tool-result and user content",
      createLine: () =>
        JSON.stringify({
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "mixed", content: "x".repeat(4_300_000) },
              { type: "text", text: "note" },
            ],
          },
        }),
    },
    {
      name: "retained assistant snapshots",
      createLine: () =>
        JSON.stringify({
          type: "assistant",
          message: { id: "snapshot", content: [{ type: "text", text: "a".repeat(4_300_000) }] },
        }),
    },
  ])("still charges $name against the raw-output budget", ({ createLine }) => {
    const parser = createClaudeParser();
    const raw = createLine();
    parser.push(`${raw}\n`);
    expect(parser.getErrorText()).toBeNull();
    parser.push(`${raw}\n`);
    expect(parser.getErrorText()).toContain("JSONL output exceeded 8388608 characters");
  });

  it("keeps the single-line limit for one oversized tool result", () => {
    const parser = createClaudeParser();
    parser.push(line(toolResultFrame("huge", "x".repeat(8 * 1024 * 1024 + 1))));
    expect(parser.getErrorText()).toContain("JSONL line exceeded 8388608 characters");
  });

  it("falls back to raw accounting for payloads too deep to re-serialize", () => {
    const parser = createClaudeParser();
    const depth = 20_000;
    const raw = `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"deep","content":""}]},"tool_use_result":${
      '{"nested":'.repeat(depth) + '"x"' + "}".repeat(depth)
    }}`;
    expect(() => parser.push(`${raw}\n`)).not.toThrow();
    expect(parser.getErrorText()).toBeNull();
  });

  it("still bounds pure tool-result floods by frames", () => {
    const parser = createClaudeParser();
    parser.push(line(toolResultFrame("repeated", [])).repeat(20_001));
    expect(parser.getErrorText()).toContain("exceeded 20000 lines");
  });
});

describe("Claude CLI partial-frame metadata accounting", () => {
  const text = { type: "text_delta", text: "a" };
  const thinking = { type: "thinking_delta", thinking: "a" };
  const frame = (delta: Record<string, unknown>, metadata: Record<string, unknown> = {}) => ({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta },
    session_id: "00000000-0000-4000-8000-000000000001",
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000000002",
    api_message_id: `msg_${"0".repeat(24)}`,
    ...metadata,
  });

  it.each([
    ["current text", text, {}, 35],
    ["thinking display", thinking, { thinking_display: "updates" }, 35],
    ["api_message_id over cap", text, { api_message_id: "m".repeat(65) }, null],
    ["display on text", text, { thinking_display: "updates" }, null],
    ["unknown record field", text, { request_id: "req_1" }, null],
  ] as const)("accounts for %s", (_name, delta, metadata, chars) => {
    const raw = JSON.stringify(frame(delta, metadata));
    expect(chargeClaudeStreamJsonLine(JSON.parse(raw), raw)).toEqual({
      chars: chars ?? raw.length,
      partialMessage: chars !== null,
    });
    const parser = createClaudeParser({ onThinkingDelta: () => {} });
    parser.push(`${raw}\n`.repeat(20_001));
    parser.finish();
    if (chars === null) {
      expect(parser.getErrorText()).toContain("exceeded 20000 lines");
    } else {
      expect(parser.getErrorText()).toBeNull();
    }
  });

  it("bounds tiny delta floods carrying current metadata", () => {
    const parser = createClaudeParser();
    const chunk = line(frame(text));
    let frames = 0;
    for (; frames < 240_000 && !parser.getErrorText(); frames += 1) {
      parser.push(chunk);
    }
    expect(parser.getErrorText()).toContain("exceeded 8388608 characters");
    expect(frames).toBe(233_017);
  });
});
