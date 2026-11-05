import { afterEach, describe, expect, it } from "vitest";
import { emitAgentEvent } from "../../infra/agent-events.js";
import {
  testing,
  getCliLiveProgressForSession,
  registerCliLiveRun,
  registerCliLiveRunForTurn,
} from "./cli-live-run.js";

afterEach(() => {
  testing.reset();
});

describe("CLI live run registry", () => {
  it("projects tool and text progress for the session's running turn", () => {
    let steerable = true;
    const live = registerCliLiveRun({
      runId: "run-1",
      provider: "claude-cli",
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:subagent:one",
      isSteerable: () => steerable,
    });
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

    const progress = getCliLiveProgressForSession({
      agentId: "main",
      sessionKey: "agent:main:subagent:one",
    });
    expect(progress).toMatchObject({
      runId: "run-1",
      provider: "claude-cli",
      activeTools: ["Bash"],
      activeToolCount: 1,
      recentTools: [
        { name: "Read", phase: "start" },
        { name: "Bash", phase: "start" },
        { name: "Read", phase: "result", isError: true },
      ],
      steerable: true,
    });
    expect(progress?.recentText).toMatch(/^Checking the logs with token /u);
    expect(progress?.recentText).not.toContain("abcdefghijklmnopqrstuvwxyz0123");

    steerable = false;
    expect(
      getCliLiveProgressForSession({ agentId: "main", sessionKey: "agent:main:subagent:one" })
        ?.steerable,
    ).toBe(false);
    live.close();
    expect(
      getCliLiveProgressForSession({ agentId: "main", sessionKey: "agent:main:subagent:one" }),
    ).toBeUndefined();
  });

  it("reports a throwing or missing steerability check as not steerable", () => {
    const throwing = registerCliLiveRun({
      runId: "run-1",
      provider: "claude-cli",
      agentId: "main",
      sessionKey: "a",
      isSteerable: () => {
        throw new Error("gone");
      },
    });
    const missing = registerCliLiveRun({
      runId: "run-2",
      provider: "claude-cli",
      agentId: "main",
      sessionKey: "b",
    });
    expect(getCliLiveProgressForSession({ agentId: "main", sessionKey: "a" })?.steerable).toBe(
      false,
    );
    expect(getCliLiveProgressForSession({ agentId: "main", sessionKey: "b" })?.steerable).toBe(
      false,
    );
    throwing.close();
    missing.close();
  });

  it("keeps a replacement turn for the same session when the older one closes", () => {
    const first = registerCliLiveRun({
      runId: "run-1",
      provider: "claude-cli",
      agentId: "main",
      sessionKey: "k",
    });
    const second = registerCliLiveRun({
      runId: "run-2",
      provider: "claude-cli",
      agentId: "main",
      sessionKey: "k",
    });
    first.close();
    expect(getCliLiveProgressForSession({ agentId: "main", sessionKey: "k" })?.runId).toBe("run-2");
    second.close();
    expect(getCliLiveProgressForSession({ agentId: "main", sessionKey: "k" })).toBeUndefined();
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

  it("tracks a turn until its signal aborts and skips side questions", () => {
    const controller = new AbortController();
    let accepts = true;
    registerCliLiveRunForTurn(
      { runId: "turn-1", provider: "claude-cli", sessionKey: "agent:ops:subagent:x" },
      controller.signal,
      () => accepts,
    );
    // The owning agent comes from the session key when the run does not name one.
    const lookup = { agentId: "ops", sessionKey: "agent:ops:subagent:x" };
    expect(getCliLiveProgressForSession(lookup)?.steerable).toBe(true);
    accepts = false;
    expect(getCliLiveProgressForSession(lookup)?.steerable).toBe(false);
    controller.abort();
    expect(getCliLiveProgressForSession(lookup)).toBeUndefined();

    registerCliLiveRunForTurn(
      {
        runId: "side-1",
        provider: "claude-cli",
        agentId: "ops",
        sessionKey: "side",
        executionMode: "side-question",
      },
      new AbortController().signal,
      () => true,
    );
    expect(getCliLiveProgressForSession({ agentId: "ops", sessionKey: "side" })).toBeUndefined();
  });
});
