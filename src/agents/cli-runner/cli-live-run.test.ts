import { afterEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../../infra/agent-events.js";
import type { CliBackendSteeringSink } from "../../plugins/cli-backend.types.js";
import {
  testing,
  CLI_STEERING_MAX_CHARS,
  deliverCliLiveRunSteering,
  getCliLiveProgressForSession,
  isCliLiveRunSteerable,
  registerCliLiveRun,
} from "./cli-live-run.js";

afterEach(() => {
  testing.reset();
});

function createSink(overrides: Partial<CliBackendSteeringSink> = {}) {
  const deliver = vi.fn<CliBackendSteeringSink["deliver"]>(
    async ({ assertCurrent, onQueued, onState }) => {
      assertCurrent();
      onQueued("steer-1");
      onState("steer-1", "consumed");
      return { id: "steer-1", acknowledged: true };
    },
  );
  return { isAvailable: () => true, deliver, ...overrides } satisfies CliBackendSteeringSink;
}

describe("CLI live run registry", () => {
  it("projects tool, text, and steering progress for the session's running turn", async () => {
    const live = registerCliLiveRun({
      runId: "run-1",
      provider: "claude-cli",
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:subagent:one",
    });
    const detach = live.steering.attach(createSink());
    emitAgentEvent({
      runId: "run-1",
      stream: "tool",
      data: { phase: "start", name: "Read", toolCallId: "call-1" },
    });
    emitAgentEvent({
      runId: "run-1",
      stream: "tool",
      data: { phase: "start", name: "Bash", toolCallId: "call-2" },
    });
    emitAgentEvent({
      runId: "run-1",
      stream: "tool",
      data: { phase: "result", name: "Read", toolCallId: "call-1", isError: true },
    });
    emitAgentEvent({
      runId: "run-1",
      stream: "assistant",
      data: { text: "Checking   the\nlogs with token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123" },
    });
    // Another run's events never reach this projection.
    emitAgentEvent({
      runId: "run-2",
      stream: "tool",
      data: { phase: "start", name: "Write", toolCallId: "call-9" },
    });

    const delivered = await deliverCliLiveRunSteering({
      runId: "run-1",
      sessionId: "session-1",
      text: "switch to plan B",
      assertCurrent: () => {},
    });
    expect(delivered).toEqual({ id: "steer-1", acknowledged: true });

    const progress = getCliLiveProgressForSession({
      agentId: "main",
      sessionKey: "agent:main:subagent:one",
    });
    expect(progress).toMatchObject({
      runId: "run-1",
      provider: "claude-cli",
      activeTools: ["Bash"],
      recentTools: [
        { name: "Read", phase: "start" },
        { name: "Bash", phase: "start" },
        { name: "Read", phase: "result", isError: true },
      ],
      steerable: true,
      steering: [{ id: "steer-1", state: "consumed", consumedAt: expect.any(Number) }],
    });
    expect(progress?.recentText).toMatch(/^Checking the logs with token /u);
    expect(progress?.recentText).not.toContain("abcdefghijklmnopqrstuvwxyz0123");

    detach();
    expect(
      getCliLiveProgressForSession({ agentId: "main", sessionKey: "agent:main:subagent:one" })
        ?.steerable,
    ).toBe(false);
    live.close();
    expect(
      getCliLiveProgressForSession({ agentId: "main", sessionKey: "agent:main:subagent:one" }),
    ).toBeUndefined();
  });

  it("bounds recent tools and text", () => {
    const live = registerCliLiveRun({
      runId: "run-1",
      provider: "claude-cli",
      agentId: "main",
      sessionKey: "k",
    });
    for (let index = 0; index < 100; index++) {
      emitAgentEvent({
        runId: "run-1",
        stream: "tool",
        data: { phase: "start", name: `Tool${index}`, toolCallId: `call-${index}` },
      });
    }
    emitAgentEvent({
      runId: "run-1",
      stream: "item",
      data: { progressText: "word ".repeat(10_000) },
    });
    const progress = getCliLiveProgressForSession({ agentId: "main", sessionKey: "k" });
    expect(progress?.recentTools).toHaveLength(8);
    expect(progress?.recentTools.at(-1)?.name).toBe("Tool99");
    expect(progress?.activeTools).toHaveLength(16);
    expect(progress?.activeTools.at(-1)).toBe("Tool99");
    expect(progress?.activeToolCount).toBe(64);
    expect(progress?.recentText).toBeDefined();
    expect(progress?.recentText?.length).toBeLessThanOrEqual(601);
    live.close();
  });

  it("redacts a credential before cutting the exposed tail through it", () => {
    const live = registerCliLiveRun({
      runId: "run-1",
      provider: "claude-cli",
      agentId: "main",
      sessionKey: "k",
    });
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";
    // The 600-character tail starts inside the credential.
    const text = `token ${secret}${" filler".repeat(84)}`;
    emitAgentEvent({ runId: "run-1", stream: "assistant", data: { text } });
    const recentText = getCliLiveProgressForSession({
      agentId: "main",
      sessionKey: "k",
    })?.recentText;
    expect(recentText).toBeDefined();
    expect(recentText).not.toContain("uvwxyz0123456789");
    live.close();
  });

  it("redacts a multi-line secret whose header falls outside the retained raw window", () => {
    const live = registerCliLiveRun({
      runId: "run-1",
      provider: "claude-cli",
      agentId: "main",
      sessionKey: "k",
    });
    // The PEM header sits more than one raw window before the exposed tail.
    const body = Array.from({ length: 160 }, (_, line) =>
      `KEYBODY${String(line).padStart(3, "0")}`.padEnd(64, "Q"),
    ).join("\n");
    const text = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----\ndone`;
    expect(text.length).toBeGreaterThan(8_000);
    emitAgentEvent({ runId: "run-1", stream: "assistant", data: { text } });
    const recentText = getCliLiveProgressForSession({
      agentId: "main",
      sessionKey: "k",
    })?.recentText;
    expect(recentText).toBeDefined();
    expect(recentText).not.toContain("KEYBODY");
    expect(recentText).toContain("done");
    live.close();
  });

  it("projects progress only for the authorized agent and session incarnation", () => {
    const main = registerCliLiveRun({
      runId: "run-main",
      provider: "claude-cli",
      agentId: "Main",
      sessionId: "incarnation-1",
      sessionKey: "main",
    });
    const other = registerCliLiveRun({
      runId: "run-other",
      provider: "claude-cli",
      agentId: "other",
      sessionId: "incarnation-9",
      sessionKey: "main",
    });
    const anonymous = registerCliLiveRun({
      runId: "run-anon",
      provider: "claude-cli",
      sessionKey: "agent:main:subagent:anon",
    });
    expect(getCliLiveProgressForSession({ agentId: "main", sessionKey: "main" })?.runId).toBe(
      "run-main",
    );
    expect(getCliLiveProgressForSession({ agentId: "other", sessionKey: "main" })?.runId).toBe(
      "run-other",
    );
    expect(
      getCliLiveProgressForSession({
        agentId: "main",
        sessionKey: "main",
        sessionId: "incarnation-2",
      }),
    ).toBeUndefined();
    expect(
      getCliLiveProgressForSession({
        agentId: "main",
        sessionKey: "main",
        sessionId: "incarnation-1",
      })?.runId,
    ).toBe("run-main");
    // A run registered without an owning agent is never projected.
    expect(
      getCliLiveProgressForSession({ agentId: "main", sessionKey: "agent:main:subagent:anon" }),
    ).toBeUndefined();
    other.close();
    expect(getCliLiveProgressForSession({ agentId: "main", sessionKey: "main" })?.runId).toBe(
      "run-main",
    );
    main.close();
    anonymous.close();
  });

  it("refuses steering without an available sink, for another session, or with invalid text", async () => {
    const live = registerCliLiveRun({ runId: "run-1", provider: "claude-cli", sessionId: "s1" });
    expect(isCliLiveRunSteerable("run-1", "s1")).toBe(false);
    await expect(
      deliverCliLiveRunSteering({ runId: "run-1", text: "hi", assertCurrent: () => {} }),
    ).rejects.toThrow("not accepting steering");

    const sink = createSink();
    live.steering.attach(sink);
    expect(isCliLiveRunSteerable("run-1", "s1")).toBe(true);
    expect(isCliLiveRunSteerable("run-1", "other")).toBe(false);
    await expect(
      deliverCliLiveRunSteering({
        runId: "run-1",
        sessionId: "other",
        text: "hi",
        assertCurrent: () => {},
      }),
    ).rejects.toThrow("not accepting steering");
    await expect(
      deliverCliLiveRunSteering({ runId: "run-1", text: "  ", assertCurrent: () => {} }),
    ).rejects.toThrow("empty");
    await expect(
      deliverCliLiveRunSteering({
        runId: "run-1",
        text: "x".repeat(CLI_STEERING_MAX_CHARS + 1),
        assertCurrent: () => {},
      }),
    ).rejects.toThrow("exceeds");
    expect(sink.deliver).not.toHaveBeenCalled();

    const throwing = createSink({
      isAvailable: () => {
        throw new Error("boom");
      },
    });
    live.steering.attach(throwing);
    expect(isCliLiveRunSteerable("run-1")).toBe(false);
    live.close();
    expect(isCliLiveRunSteerable("run-1")).toBe(false);
  });

  it("fails the native-effect assertion once the turn is replaced or closed", async () => {
    const first = registerCliLiveRun({
      runId: "run-1",
      provider: "claude-cli",
      agentId: "main",
      sessionKey: "k",
    });
    let assertion: (() => void) | undefined;
    const release = Promise.withResolvers<void>();
    first.steering.attach(
      createSink({
        deliver: async ({ assertCurrent, onQueued }) => {
          assertion = assertCurrent;
          await release.promise;
          assertCurrent();
          onQueued("late");
          return { id: "late", acknowledged: true };
        },
      }),
    );
    const pending = deliverCliLiveRunSteering({
      runId: "run-1",
      text: "hi",
      assertCurrent: () => {},
    });
    await vi.waitFor(() => expect(assertion).toBeDefined());
    // A newer turn for the same run replaces the registration before the write.
    const second = registerCliLiveRun({
      runId: "run-1",
      provider: "claude-cli",
      agentId: "main",
      sessionKey: "k",
    });
    release.resolve();
    await expect(pending).rejects.toThrow("no longer accepting steering");
    first.close();
    // Closing the replaced registration leaves the newer one visible.
    expect(getCliLiveProgressForSession({ agentId: "main", sessionKey: "k" })).toBeDefined();
    second.close();
    expect(getCliLiveProgressForSession({ agentId: "main", sessionKey: "k" })).toBeUndefined();
  });

  it("propagates the host source assertion and marks queued steering dropped on close", async () => {
    const live = registerCliLiveRun({
      runId: "run-1",
      provider: "claude-cli",
      agentId: "main",
      sessionKey: "k",
    });
    live.steering.attach(
      createSink({
        deliver: async ({ assertCurrent, onQueued }) => {
          assertCurrent();
          onQueued("queued-1");
          return { id: "queued-1", acknowledged: true };
        },
      }),
    );
    await expect(
      deliverCliLiveRunSteering({
        runId: "run-1",
        text: "hi",
        assertCurrent: () => {
          throw new Error("source revoked");
        },
      }),
    ).rejects.toThrow("source revoked");
    await deliverCliLiveRunSteering({ runId: "run-1", text: "hi", assertCurrent: () => {} });
    expect(getCliLiveProgressForSession({ agentId: "main", sessionKey: "k" })?.steering).toEqual([
      expect.objectContaining({ id: "queued-1", state: "queued" }),
    ]);
    const entries = getCliLiveProgressForSession({ agentId: "main", sessionKey: "k" })?.steering;
    live.close();
    // Snapshots are copies; the closed run is no longer visible.
    expect(entries?.[0]?.state).toBe("queued");
    expect(getCliLiveProgressForSession({ agentId: "main", sessionKey: "k" })).toBeUndefined();
  });
});
