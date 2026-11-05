/**
 * Claude Code persists a hook's `additionalContext` to a side file once it passes about 10,000
 * characters and shows the model only a 2 KB preview. Turn context such as a completed child's
 * result then never reaches the model, and a tool-less completion turn cannot open the file.
 * Each registered UserPromptSubmit callback is persisted on its own, so the host splits large
 * context across several callbacks that each stay below that threshold.
 */
export const CLAUDE_HOOK_CONTEXT_PART_MAX_CHARS = 8_000;
export const CLAUDE_HOOK_CONTEXT_MAX_PARTS = 16;
export const CLAUDE_PROMPT_HOOK_CALLBACK_IDS: readonly string[] = Array.from(
  { length: CLAUDE_HOOK_CONTEXT_MAX_PARTS },
  (_, index) => (index === 0 ? "UserPromptSubmit" : `UserPromptSubmit:${index}`),
);

// Room for the part header; it is far shorter than this.
const PART_HEADER_RESERVE = 96;

function partHeader(index: number, count: number): string {
  return `[OpenClaw turn context part ${index + 1} of ${count}; parts continue each other in order]\n`;
}

/** Returns the zero-based context part a prompt callback owns, or undefined for other callbacks. */
export function resolveClaudePromptHookPart(callbackId: unknown): number | undefined {
  if (typeof callbackId !== "string") {
    return undefined;
  }
  const index = CLAUDE_PROMPT_HOOK_CALLBACK_IDS.indexOf(callbackId);
  return index < 0 ? undefined : index;
}

function splitPoint(text: string, offset: number, budget: number): number {
  const end = offset + budget;
  if (end >= text.length) {
    return text.length;
  }
  // Prefer a line boundary in the second half so prompt-data blocks stay readable.
  const newline = text.lastIndexOf("\n", end - 1);
  if (newline >= offset + budget / 2) {
    return newline + 1;
  }
  const code = text.charCodeAt(end - 1);
  // Never separate a surrogate pair.
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

/** Splits hook context into ordered parts that Claude Code delivers inline. */
export function splitClaudeHookAdditionalContext(
  text: string,
  options: { maxChars?: number; maxParts?: number } = {},
): string[] {
  const maxChars = options.maxChars ?? CLAUDE_HOOK_CONTEXT_PART_MAX_CHARS;
  const maxParts = options.maxParts ?? CLAUDE_HOOK_CONTEXT_MAX_PARTS;
  if (!text) {
    return [];
  }
  if (text.length <= maxChars) {
    return [text];
  }
  const budget = maxChars - PART_HEADER_RESERVE;
  const bodies: string[] = [];
  let offset = 0;
  while (offset < text.length && bodies.length < maxParts) {
    const end = splitPoint(text, offset, budget);
    bodies.push(text.slice(offset, end));
    offset = end;
  }
  if (offset < text.length) {
    const last = bodies.length - 1;
    const lastBody = bodies[last] ?? "";
    const lastStart = offset - lastBody.length;
    // The notice length is bounded by the digits of text.length; reserve it before cutting.
    const noticeReserve =
      `\n[OpenClaw turn context truncated: ${text.length} more characters were not delivered]`
        .length;
    const kept = splitPoint(text, lastStart, budget - noticeReserve) - lastStart;
    const omitted = text.length - (lastStart + kept);
    bodies[last] =
      lastBody.slice(0, kept) +
      `\n[OpenClaw turn context truncated: ${omitted} more characters were not delivered]`;
  }
  return bodies.map((body, index) => partHeader(index, bodies.length) + body);
}
