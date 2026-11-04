import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { heartbeatLog } from "./heartbeat-log.js";
import type { HeartbeatRunResult, HeartbeatWakeRequest } from "./heartbeat-wake-contracts.js";

/**
 * A scheduled occurrence that stays busy for a whole cadence is superseded by the
 * next tick. Without a bound, the waiting cron run never settles and never reschedules.
 */
export const SESSION_EVENT_SKIP_STARVED = "starved";
export const SESSION_EVENT_STARVATION_FALLBACK_MS = 60 * 60_000;

export type StarvationWaitOptions = {
  /**
   * Scheduled/task waiters only: owner cadence after which busy retries settle as
   * starved. Defaults to the request's `scheduledEveryMs`, then the fallback window.
   */
  starveAfterMs?: number;
};
export type StarvableWaiter = {
  active: boolean;
  starveAt?: number;
  settle: (result: HeartbeatRunResult) => void;
};
type StarvableWake = Pick<HeartbeatWakeRequest, "intent" | "agentId" | "sessionKey"> & {
  /** Set only while every represented request is a scheduled monitor or task occurrence. */
  starveAt?: number;
  workStarted: boolean;
  settlements: StarvableWaiter[];
};

/**
 * Monotonic starvation deadline for scheduled/task requests: the owner's cadence,
 * then the request's monitor cadence, then the fallback window. Others never starve.
 */
export function resolveStarveAt(
  request: Pick<HeartbeatWakeRequest, "intent" | "scheduledEveryMs">,
  starveAfterMs?: number,
): number | undefined {
  if (request.intent !== "scheduled" && request.intent !== "task") {
    return undefined;
  }
  return (
    performance.now() +
    (asPositiveSafeInteger(starveAfterMs) ??
      asPositiveSafeInteger(request.scheduledEveryMs) ??
      SESSION_EVENT_STARVATION_FALLBACK_MS)
  );
}

/** A merged wake stays starvable only when both sides are scheduled-only. */
export function mergeStarveAt(
  previous: number | undefined,
  next: number | undefined,
): number | undefined {
  return previous === undefined || next === undefined ? undefined : Math.min(previous, next);
}

/**
 * Releases scheduled waiters whose cadence elapsed under busy retries. Event payloads
 * (exec completions, cron events) keep their unbounded retry; only scheduled waiters
 * riding on a mixed wake are released. Guard deferrals carry their own deadline.
 * Returns true when the whole never-started scheduled wake should be dropped.
 */
export function releaseStarvedWaiters(wake: StarvableWake, reason: string): boolean {
  const now = performance.now();
  const starved = { status: "skipped", reason: SESSION_EVENT_SKIP_STARVED } as const;
  for (const entry of wake.settlements) {
    if (entry.active && entry.starveAt !== undefined && entry.starveAt <= now) {
      entry.settle(starved);
    }
  }
  if (
    wake.workStarted ||
    wake.starveAt === undefined ||
    wake.starveAt > now ||
    wake.settlements.some((entry) => entry.active)
  ) {
    return false;
  }
  heartbeatLog.warn("scheduled heartbeat starved by busy work; yielding to next tick", {
    intent: wake.intent,
    agentId: wake.agentId,
    sessionKey: wake.sessionKey,
    lastSkipReason: reason,
  });
  return true;
}
