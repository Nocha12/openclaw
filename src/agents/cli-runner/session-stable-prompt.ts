import type { CliSessionBinding } from "../../config/sessions/types.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { EmbeddedRunTrigger } from "../run-trigger.js";

/**
 * Claude CLI resends the system prompt on every resumed turn, and provider prompt caching keys on
 * the exact prefix. Channel turns, background turns (heartbeat, events, inter-session handoffs)
 * and `openclaw agent` turns build that prompt through different paths, so alternating between
 * them rewrote the whole cached conversation. The channel turn owns the session's prompt; other
 * turns resume with it and carry their per-turn differences in the user turn instead.
 *
 * Background turns may resolve lighter or requester-less bootstrap context, so the pin is not
 * keyed on context files: the next owner turn refreshes it. Only direct chats pin, because the
 * owner prompt can carry the requester's personal bootstrap files.
 */
export type CliStablePromptTurnRole = "owner" | "background" | "other";

export type CliStablePromptPin = {
  sessionId?: string;
  modelId?: string;
  extraSystemPromptHash?: string;
  promptToolNamesHash?: string;
  systemPrompt: string;
  extraSystemPrompt: string;
  toolNames: string[];
};

const MAX_PINS = 256;
const pins = new Map<string, CliStablePromptPin>();

function pinKey(provider: string, sessionKey: string | undefined): string | undefined {
  const key = sessionKey?.trim();
  return key ? `${provider}\u0000${key}` : undefined;
}

export function classifyCliStablePromptTurn(params: {
  trigger?: EmbeddedRunTrigger;
  inputProvenance?: InputProvenance;
  hasSessionStaticPrompt: boolean;
}): CliStablePromptTurnRole {
  if (
    params.trigger === "heartbeat" ||
    params.trigger === "event" ||
    params.inputProvenance?.kind === "inter_session" ||
    params.inputProvenance?.kind === "internal_system"
  ) {
    return "background";
  }
  if (params.trigger === "cron" || params.trigger === "memory" || params.trigger === "overflow") {
    return "other";
  }
  // Channel ingress declares the session-stable part of its prompt; command turns do not.
  return params.hasSessionStaticPrompt ? "owner" : "background";
}

export function recordCliStablePrompt(
  provider: string,
  sessionKey: string | undefined,
  pin: CliStablePromptPin,
): void {
  const key = pinKey(provider, sessionKey);
  if (!key || !pin.systemPrompt.trim()) {
    return;
  }
  pins.delete(key);
  pins.set(key, { ...pin, toolNames: [...pin.toolNames] });
  while (pins.size > MAX_PINS) {
    const oldest = pins.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    pins.delete(oldest);
  }
}

/** Returns the owner prompt only while the stored native session was last bound to it. */
export function findReusableCliStablePrompt(params: {
  provider: string;
  sessionKey?: string;
  sessionId?: string;
  modelId?: string;
  binding?: CliSessionBinding;
}): CliStablePromptPin | undefined {
  const key = pinKey(params.provider, params.sessionKey);
  const pin = key ? pins.get(key) : undefined;
  const binding = params.binding;
  if (!pin || !binding?.sessionId?.trim()) {
    return undefined;
  }
  if (
    pin.sessionId !== params.sessionId ||
    pin.modelId !== params.modelId ||
    (binding.extraSystemPromptHash ?? undefined) !== pin.extraSystemPromptHash ||
    (binding.promptToolNamesHash ?? undefined) !== pin.promptToolNamesHash
  ) {
    return undefined;
  }
  return pin;
}

/** Per-turn differences that the pinned system prompt does not describe. */
export function buildCliStablePromptTurnDelta(params: {
  pin: CliStablePromptPin;
  extraSystemPrompt: string;
  toolNames: readonly string[];
}): string | undefined {
  const parts: string[] = [];
  const turnExtra = params.extraSystemPrompt.trim();
  if (turnExtra && turnExtra !== params.pin.extraSystemPrompt.trim()) {
    parts.push(`Turn-specific context (applies to this turn only):\n${turnExtra}`);
  }
  const current = new Set(params.toolNames);
  const pinned = new Set(params.pin.toolNames);
  const unavailable = params.pin.toolNames.filter((name) => !current.has(name)).toSorted();
  const added = params.toolNames.filter((name) => !pinned.has(name)).toSorted();
  if (unavailable.length > 0) {
    parts.push(`Tools unavailable this turn: ${unavailable.join(", ")}.`);
  }
  if (added.length > 0) {
    parts.push(`Additional tools available this turn: ${added.join(", ")}.`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export function resetCliStablePromptPinsForTest(): void {
  pins.clear();
}
