import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  SESSION_EVENT_SKIP_STARVED,
  SESSION_EVENT_STARVATION_FALLBACK_MS,
} from "./session-event-wake-starvation.js";
import {
  SESSION_EVENT_IDLE_RETRY_MS,
  markSessionEventWakeWorkStarted,
  requestSessionEventWakeAndWait,
  setSessionEventWakeHandler as setRuntimeSessionEventWakeHandler,
} from "./session-event-wake.js";

describe("session event wake starvation bound", () => {
  type WakeRequest = Parameters<typeof requestSessionEventWakeAndWait>[0];
  type WakeHandler = NonNullable<Parameters<typeof setRuntimeSessionEventWakeHandler>[0]>;
  const cadenceMs = 5 * 60_000;
  const busy = { status: "skipped" as const, reason: "requests-in-flight" };
  const starved = { status: "skipped" as const, reason: SESSION_EVENT_SKIP_STARVED };
  let disposeHandler: (() => void) | undefined;

  function setSessionEventWakeHandler(handler: WakeHandler): void {
    disposeHandler = setRuntimeSessionEventWakeHandler(handler);
  }

  function scheduled(overrides: Partial<WakeRequest> = {}): WakeRequest {
    return {
      source: "interval",
      intent: "scheduled",
      reason: "interval",
      agentId: "main",
      scheduledEveryMs: cadenceMs,
      coalesceMs: 0,
      ...overrides,
    };
  }

  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    resetGatewayWorkAdmission();
    disposeHandler?.();
    const disposeDrain = setRuntimeSessionEventWakeHandler(async () => ({
      status: "skipped",
      reason: "disabled",
    }));
    await vi.runAllTimersAsync();
    disposeDrain();
    disposeHandler = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["requests-in-flight", "cron-in-progress"])(
    "settles a scheduled monitor busy (%s) for a whole cadence as starved and drops it",
    async (reason) => {
      const handler = vi.fn<WakeHandler>(async () => ({ status: "skipped", reason }));
      setSessionEventWakeHandler(handler);
      const settled = vi.fn();
      const result = requestSessionEventWakeAndWait(scheduled());
      void result.then(settled);

      await vi.advanceTimersByTimeAsync(cadenceMs - 1);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_IDLE_RETRY_MS + 1);
      expect(settled).toHaveBeenCalledExactlyOnceWith(starved);
      expect(await result).toEqual(starved);

      const calls = handler.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10 * SESSION_EVENT_IDLE_RETRY_MS);
      expect(handler).toHaveBeenCalledTimes(calls);
    },
  );

  it("bounds a cadence-less task wake by the fallback window", async () => {
    const handler = vi.fn<WakeHandler>(async () => busy);
    setSessionEventWakeHandler(handler);
    const settled = vi.fn();
    const result = requestSessionEventWakeAndWait(
      scheduled({
        intent: "task",
        reason: "heartbeat-task:inbox",
        scheduledEveryMs: undefined,
        tasks: [{ jobId: "inbox", name: "inbox", prompt: "Check inbox" }],
      }),
    );
    void result.then(settled);

    await vi.advanceTimersByTimeAsync(SESSION_EVENT_STARVATION_FALLBACK_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SESSION_EVENT_IDLE_RETRY_MS + 1);
    expect(await result).toEqual(starved);
  });

  it("honors the owner cadence for a task wake instead of the fallback", async () => {
    const dayMs = 24 * 60 * 60_000;
    const handler = vi.fn<WakeHandler>(async () => ({
      status: "skipped",
      reason: "cron-in-progress",
    }));
    setSessionEventWakeHandler(handler);
    const settled = vi.fn();
    const result = requestSessionEventWakeAndWait(
      scheduled({
        intent: "task",
        reason: "heartbeat-task:daily",
        scheduledEveryMs: undefined,
        tasks: [{ jobId: "daily", name: "daily", prompt: "Daily digest" }],
      }),
      { starveAfterMs: dayMs },
    );
    void result.then(settled);

    await vi.advanceTimersByTimeAsync(2 * SESSION_EVENT_STARVATION_FALLBACK_MS);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(dayMs);
    expect(await result).toEqual(starved);
  });

  it("does not spend guard deferrals as starvation", async () => {
    const handler = vi
      .fn<WakeHandler>()
      .mockImplementationOnce(async () => ({
        status: "skipped",
        reason: "min-spacing",
        retryAtMs: Date.now() + 2 * cadenceMs,
      }))
      // Past the cadence: a guard skip retains, it does not starve.
      .mockImplementationOnce(async () => ({
        status: "skipped",
        reason: "min-spacing",
        retryAtMs: Date.now() + 1_000,
      }))
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    setSessionEventWakeHandler(handler);
    const result = requestSessionEventWakeAndWait(
      scheduled({ intent: "task", tasks: [{ jobId: "t", name: "t", prompt: "p" }] }),
    );

    await vi.advanceTimersByTimeAsync(2 * cadenceMs + 2_000);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(await result).toEqual({ status: "ran", durationMs: 1 });
  });

  it("keeps exec-completion event wakes retrying past any starvation window", async () => {
    let idle = false;
    const handler = vi.fn<WakeHandler>(async () =>
      idle ? { status: "ran", durationMs: 1 } : busy,
    );
    setSessionEventWakeHandler(handler);
    const settled = vi.fn();
    const result = requestSessionEventWakeAndWait({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      agentId: "main",
      sessionKey: "agent:main:main",
      coalesceMs: 0,
    });
    void result.then(settled);

    // Literal span so this control also holds on the unbounded pre-fix queue.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(settled).not.toHaveBeenCalled();
    idle = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toEqual({ status: "ran", durationMs: 1 });
  });

  it("releases only the scheduled waiter when its tick rides an event wake", async () => {
    let idle = false;
    const handler = vi.fn<WakeHandler>(async () =>
      idle ? { status: "ran", durationMs: 1 } : busy,
    );
    setSessionEventWakeHandler(handler);
    const scheduledSettled = vi.fn();
    const eventSettled = vi.fn();
    const tick = requestSessionEventWakeAndWait(scheduled({ coalesceMs: 100 }));
    const event = requestSessionEventWakeAndWait({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      agentId: "main",
      coalesceMs: 100,
    });
    void tick.then(scheduledSettled);
    void event.then(eventSettled);

    await vi.advanceTimersByTimeAsync(cadenceMs + SESSION_EVENT_IDLE_RETRY_MS + 1_000);
    expect(scheduledSettled).toHaveBeenCalledExactlyOnceWith(starved);
    expect(eventSettled).not.toHaveBeenCalled();

    idle = true;
    await vi.advanceTimersByTimeAsync(SESSION_EVENT_IDLE_RETRY_MS);
    expect(await event).toEqual({ status: "ran", durationMs: 1 });
  });

  it("releases the waiter but retains admitted scheduled work", async () => {
    let idle = false;
    const handler = vi.fn<WakeHandler>(async () => {
      markSessionEventWakeWorkStarted();
      return idle ? { status: "ran", durationMs: 1 } : busy;
    });
    setSessionEventWakeHandler(handler);
    const result = requestSessionEventWakeAndWait(scheduled());

    await vi.advanceTimersByTimeAsync(cadenceMs + SESSION_EVENT_IDLE_RETRY_MS);
    expect(await result).toEqual(starved);
    const calls = handler.mock.calls.length;
    idle = true;
    await vi.advanceTimersByTimeAsync(SESSION_EVENT_IDLE_RETRY_MS);
    expect(handler.mock.calls.length).toBeGreaterThan(calls);
    expect(await handler.mock.results.at(-1)?.value).toEqual({ status: "ran", durationMs: 1 });
  });

  it("still runs a scheduled monitor that becomes idle within its cadence", async () => {
    const handler = vi
      .fn<WakeHandler>()
      .mockResolvedValueOnce(busy)
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    setSessionEventWakeHandler(handler);
    const result = requestSessionEventWakeAndWait(scheduled());

    await vi.advanceTimersByTimeAsync(SESSION_EVENT_IDLE_RETRY_MS + 1);
    expect(await result).toEqual({ status: "ran", durationMs: 1 });
  });
});
