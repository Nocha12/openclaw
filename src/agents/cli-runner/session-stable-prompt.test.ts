import { afterEach, describe, expect, it } from "vitest";
import type { CliSessionBinding } from "../../config/sessions/types.js";
import {
  buildCliStablePromptTurnDelta,
  classifyCliStablePromptTurn,
  findReusableCliStablePrompt,
  recordCliStablePrompt,
  resetCliStablePromptPinsForTest,
  type CliStablePromptPin,
} from "./session-stable-prompt.js";

const provider = "claude-cli";
const sessionKey = "agent:main:telegram:direct:1222";
const modelId = "claude-opus-5-5";

function ownerPin(overrides: Partial<CliStablePromptPin> = {}): CliStablePromptPin {
  return {
    sessionId: "openclaw-session",
    modelId,
    extraSystemPromptHash: "extra-owner",
    promptToolNamesHash: "tools-owner",
    systemPrompt: "OWNER SYSTEM PROMPT",
    extraSystemPrompt: "You are in a Telegram direct conversation.",
    toolNames: ["exec", "message", "sessions_spawn"],
    ...overrides,
  };
}

function boundTo(pin: CliStablePromptPin): CliSessionBinding {
  return {
    sessionId: "claude-native-session",
    extraSystemPromptHash: pin.extraSystemPromptHash,
    promptToolNamesHash: pin.promptToolNamesHash,
  };
}

afterEach(() => {
  resetCliStablePromptPinsForTest();
});

describe("classifyCliStablePromptTurn", () => {
  it("lets only channel turns with a session-stable prompt own the session prefix", () => {
    expect(classifyCliStablePromptTurn({ trigger: "user", hasSessionStaticPrompt: true })).toBe(
      "owner",
    );
    expect(classifyCliStablePromptTurn({ hasSessionStaticPrompt: true })).toBe("owner");
  });

  it.each([
    { trigger: "heartbeat" as const, hasSessionStaticPrompt: true },
    { trigger: "event" as const, hasSessionStaticPrompt: true },
    {
      trigger: "user" as const,
      inputProvenance: { kind: "inter_session" as const },
      hasSessionStaticPrompt: false,
    },
    {
      trigger: "user" as const,
      inputProvenance: { kind: "internal_system" as const },
      hasSessionStaticPrompt: true,
    },
    // `openclaw agent --session-key ... --deliver` carries no session-stable prompt.
    { trigger: "user" as const, hasSessionStaticPrompt: false },
  ])("treats $trigger/$inputProvenance turns as background", (turn) => {
    expect(classifyCliStablePromptTurn(turn)).toBe("background");
  });

  it("leaves cron and maintenance turns alone", () => {
    expect(classifyCliStablePromptTurn({ trigger: "cron", hasSessionStaticPrompt: true })).toBe(
      "other",
    );
    expect(classifyCliStablePromptTurn({ trigger: "memory", hasSessionStaticPrompt: false })).toBe(
      "other",
    );
  });
});

describe("findReusableCliStablePrompt", () => {
  it("keeps the system prompt and binding hashes identical across turn kinds", () => {
    const pin = ownerPin();
    recordCliStablePrompt(provider, sessionKey, pin);

    // A heartbeat, an inter-session completion and an `openclaw agent` turn follow.
    for (let turn = 0; turn < 3; turn += 1) {
      const reused = findReusableCliStablePrompt({
        provider,
        sessionKey,
        sessionId: "openclaw-session",
        modelId,
        binding: boundTo(pin),
      });
      expect(reused?.systemPrompt).toBe(pin.systemPrompt);
      expect(reused?.extraSystemPromptHash).toBe(pin.extraSystemPromptHash);
      expect(reused?.promptToolNamesHash).toBe(pin.promptToolNamesHash);
    }
  });

  it("is scoped to provider and session key", () => {
    const pin = ownerPin();
    recordCliStablePrompt(provider, sessionKey, pin);
    const lookup = { sessionId: "openclaw-session", modelId, binding: boundTo(pin) };
    expect(findReusableCliStablePrompt({ ...lookup, provider: "codex-cli", sessionKey })).toBe(
      undefined,
    );
    expect(
      findReusableCliStablePrompt({ ...lookup, provider, sessionKey: "agent:main:other" }),
    ).toBe(undefined);
    expect(findReusableCliStablePrompt({ ...lookup, provider, sessionKey: undefined })).toBe(
      undefined,
    );
  });

  it("refuses a pin the stored native session is not bound to", () => {
    const pin = ownerPin();
    recordCliStablePrompt(provider, sessionKey, pin);
    const base = { provider, sessionKey, sessionId: "openclaw-session", modelId };
    expect(findReusableCliStablePrompt({ ...base, binding: undefined })).toBe(undefined);
    expect(
      findReusableCliStablePrompt({
        ...base,
        binding: { ...boundTo(pin), extraSystemPromptHash: "something-else" },
      }),
    ).toBe(undefined);
    expect(
      findReusableCliStablePrompt({
        ...base,
        binding: { ...boundTo(pin), promptToolNamesHash: undefined },
      }),
    ).toBe(undefined);
  });

  it("refreshes when the model or the OpenClaw session changes", () => {
    const pin = ownerPin();
    recordCliStablePrompt(provider, sessionKey, pin);
    const base = { provider, sessionKey, binding: boundTo(pin) };
    expect(
      findReusableCliStablePrompt({
        ...base,
        sessionId: "openclaw-session",
        modelId: "claude-sonnet-5-5",
      }),
    ).toBe(undefined);
    expect(findReusableCliStablePrompt({ ...base, sessionId: "after-reset", modelId })).toBe(
      undefined,
    );
  });

  it("follows the latest owner turn", () => {
    recordCliStablePrompt(provider, sessionKey, ownerPin());
    const next = ownerPin({ systemPrompt: "NEXT", extraSystemPromptHash: "extra-next" });
    recordCliStablePrompt(provider, sessionKey, next);
    expect(
      findReusableCliStablePrompt({
        provider,
        sessionKey,
        sessionId: "openclaw-session",
        modelId,
        binding: boundTo(next),
      })?.systemPrompt,
    ).toBe("NEXT");
  });
});

describe("buildCliStablePromptTurnDelta", () => {
  it("adds nothing when the turn matches the pinned prompt", () => {
    const pin = ownerPin();
    expect(
      buildCliStablePromptTurnDelta({
        pin,
        extraSystemPrompt: pin.extraSystemPrompt,
        toolNames: [...pin.toolNames].toReversed(),
      }),
    ).toBe(undefined);
  });

  it("moves per-turn guidance and tool differences into the user turn", () => {
    const delta = buildCliStablePromptTurnDelta({
      pin: ownerPin(),
      extraSystemPrompt: "### Delivery Format\nplain",
      toolNames: ["exec", "heartbeat_respond"],
    });
    expect(delta).toBe(
      [
        "Turn-specific context (applies to this turn only):\n### Delivery Format\nplain",
        "Tools unavailable this turn: message, sessions_spawn.",
        "Additional tools available this turn: heartbeat_respond.",
      ].join("\n\n"),
    );
  });
});
