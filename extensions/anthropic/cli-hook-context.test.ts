import { describe, expect, it } from "vitest";
import {
  CLAUDE_HOOK_CONTEXT_MAX_PARTS,
  CLAUDE_HOOK_CONTEXT_PART_MAX_CHARS,
  CLAUDE_PROMPT_HOOK_CALLBACK_IDS,
  resolveClaudePromptHookPart,
  splitClaudeHookAdditionalContext,
} from "./cli-hook-context.js";

const HEADER =
  /^\[OpenClaw turn context part (\d+) of (\d+); parts continue each other in order\]\n/u;

function bodies(parts: string[]): string[] {
  return parts.map((part) => part.replace(HEADER, ""));
}

describe("splitClaudeHookAdditionalContext", () => {
  it("keeps context below the native preview threshold unchanged", () => {
    expect(splitClaudeHookAdditionalContext("")).toEqual([]);
    const text = "x".repeat(CLAUDE_HOOK_CONTEXT_PART_MAX_CHARS);
    expect(splitClaudeHookAdditionalContext(text)).toEqual([text]);
  });

  it("splits a long child result into ordered, lossless parts on line boundaries", () => {
    const text = Array.from({ length: 900 }, (_, index) => `line ${index}: 완료 보고 본문`).join(
      "\n",
    );
    const parts = splitClaudeHookAdditionalContext(text);

    expect(parts.length).toBeGreaterThan(1);
    for (const [index, part] of parts.entries()) {
      expect(part.length).toBeLessThanOrEqual(CLAUDE_HOOK_CONTEXT_PART_MAX_CHARS);
      expect(HEADER.exec(part)?.slice(1)).toEqual([String(index + 1), String(parts.length)]);
    }
    expect(bodies(parts).join("")).toBe(text);
    // Every part but the last ends at a line boundary.
    for (const body of bodies(parts).slice(0, -1)) {
      expect(body.endsWith("\n")).toBe(true);
    }
  });

  it("never separates a surrogate pair when no line boundary is available", () => {
    const text = "🦞".repeat(CLAUDE_HOOK_CONTEXT_PART_MAX_CHARS);
    const parts = splitClaudeHookAdditionalContext(text);

    expect(bodies(parts).join("")).toBe(text);
    for (const body of bodies(parts)) {
      expect(body).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    }
  });

  it("bounds the part count and says how much was not delivered", () => {
    const text = "y".repeat(
      CLAUDE_HOOK_CONTEXT_PART_MAX_CHARS * (CLAUDE_HOOK_CONTEXT_MAX_PARTS + 2),
    );
    const parts = splitClaudeHookAdditionalContext(text);

    expect(parts).toHaveLength(CLAUDE_HOOK_CONTEXT_MAX_PARTS);
    const last = parts.at(-1) ?? "";
    expect(last.length).toBeLessThanOrEqual(CLAUDE_HOOK_CONTEXT_PART_MAX_CHARS);
    const omitted = Number(/truncated: (\d+) more characters/u.exec(last)?.[1]);
    const delivered = bodies(parts)
      .join("")
      .replace(
        /\n\[OpenClaw turn context truncated: \d+ more characters were not delivered\]$/u,
        "",
      );
    expect(delivered.length + omitted).toBe(text.length);
  });
});

describe("resolveClaudePromptHookPart", () => {
  it("maps each registered prompt callback to its part and ignores other callbacks", () => {
    expect(CLAUDE_PROMPT_HOOK_CALLBACK_IDS[0]).toBe("UserPromptSubmit");
    expect(CLAUDE_PROMPT_HOOK_CALLBACK_IDS).toHaveLength(CLAUDE_HOOK_CONTEXT_MAX_PARTS);
    for (const [index, id] of CLAUDE_PROMPT_HOOK_CALLBACK_IDS.entries()) {
      expect(resolveClaudePromptHookPart(id)).toBe(index);
    }
    expect(resolveClaudePromptHookPart("PreToolUse")).toBeUndefined();
    expect(resolveClaudePromptHookPart(`UserPromptSubmit:${CLAUDE_HOOK_CONTEXT_MAX_PARTS}`)).toBe(
      undefined,
    );
    expect(resolveClaudePromptHookPart(undefined)).toBeUndefined();
  });
});
