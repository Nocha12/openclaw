import { describe, expect, it } from "vitest";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { getCliLiveProgressForSession, registerCliLiveRunForTurn } from "./cli-live-run.js";

const session = { agentId: "ops", sessionKey: "agent:ops:subagent:live", sessionId: "current" };

describe("running CLI progress", () => {
  it("projects bounded tool status and masked text until the turn closes", () => {
    const controller = new AbortController();
    const runId = "cli-progress";
    let acceptsInjection = false;
    registerCliLiveRunForTurn(
      { ...session, runId, provider: "claude-cli" },
      controller.signal,
      () => acceptsInjection,
    );
    try {
      for (let index = 0; index < 18; index++) {
        emitAgentEvent({
          runId,
          stream: "tool",
          data: { phase: "start", name: `tool-${index}`, toolCallId: String(index) },
        });
      }
      emitAgentEvent({
        runId,
        stream: "tool",
        data: { phase: "result", name: "tool-17", toolCallId: "17", isError: true },
      });
      const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";
      emitAgentEvent({ runId, stream: "thinking", data: { text: "private reasoning" } });
      emitAgentEvent({
        runId,
        stream: "item",
        data: { progressText: `working\ntoken ${secret}` },
      });
      const progress = getCliLiveProgressForSession(session);
      expect(progress).toMatchObject({
        runId,
        provider: "claude-cli",
        activeToolCount: 17,
        steerable: false,
      });
      expect(progress?.activeTools).toHaveLength(16);
      expect(progress?.activeTools.at(-1)).toBe("tool-16");
      expect(progress?.recentTools).toHaveLength(8);
      expect(progress?.recentTools.at(-1)).toMatchObject({
        name: "tool-17",
        phase: "result",
        isError: true,
      });
      expect(progress?.recentText).toContain("working token");
      expect(progress?.recentText).not.toContain(secret);
      expect(JSON.stringify(progress)).not.toContain("private reasoning");
      acceptsInjection = true;
      expect(getCliLiveProgressForSession(session)?.steerable).toBe(true);
    } finally {
      controller.abort();
    }
    expect(getCliLiveProgressForSession(session)).toBeUndefined();
  });

  it("redacts a long assistant event before discarding the prefix", () => {
    const controller = new AbortController();
    const runId = "cli-progress-pem";
    registerCliLiveRunForTurn(
      { ...session, runId, provider: "claude-cli" },
      controller.signal,
      () => false,
    );
    try {
      const body = Array.from({ length: 160 }, () => "PRIVATE_FIXTURE_TAIL".padEnd(64, "Q")).join(
        "\n",
      );
      emitAgentEvent({
        runId,
        stream: "assistant",
        data: {
          text: "not the latest completed text",
          completedText: `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----\nReady`,
        },
      });
      const progress = getCliLiveProgressForSession(session);
      expect(progress?.recentText).toContain("Ready");
      expect(progress?.recentText).not.toContain("PRIVATE_FIXTURE_TAIL");
      expect(progress?.recentText).not.toContain("not the latest completed text");
    } finally {
      controller.abort();
    }
  });

  it("ignores side questions and keeps a replacement separate from an older turn", () => {
    const first = new AbortController();
    const second = new AbortController();
    registerCliLiveRunForTurn(
      { ...session, runId: "original", provider: "claude-cli" },
      first.signal,
      () => false,
    );
    try {
      const replacement = { ...session, sessionId: "replacement", runId: "new", provider: "cli" };
      registerCliLiveRunForTurn(
        { ...replacement, executionMode: "side-question" },
        second.signal,
        () => true,
      );
      expect(getCliLiveProgressForSession(session)?.runId).toBe("original");
      registerCliLiveRunForTurn(replacement, second.signal, () => true);
      first.abort();
      expect(getCliLiveProgressForSession(session)).toBeUndefined();
      expect(getCliLiveProgressForSession({ ...replacement, agentId: "other" })).toBeUndefined();
      expect(getCliLiveProgressForSession(replacement)?.runId).toBe("new");
    } finally {
      first.abort();
      second.abort();
    }
  });
});
