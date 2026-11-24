import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import { CLI_STREAM_JSON_OUTPUT_LIMITS } from "../cli-output-stream-limits.js";
import { runPreparedCliAgent as runPreparedCliAgentImpl } from "../cli-runner.js";
import * as cliTranscript from "../command/attempt-execution.helpers.js";
import { hasModelFallbackStop } from "../failover-error.js";
import { buildContext } from "./execute-events.tool-result-args.test-support.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";
import type { PreparedCliRunContext } from "./types.js";

const runPreparedCliAgent = wrapPreparedCliRunWithTestAdmission(runPreparedCliAgentImpl);

// mock-isolation: The supervisor fixture owns execution; never spawn host CLI processes.
vi.mock("../../process/supervisor/adapters/child.js", () => ({
  createChildAdapter: vi.fn(),
}));

type SupervisorSpawnInput = Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];

const { maxPendingLineChars, maxTurnRawChars } = CLI_STREAM_JSON_OUTPUT_LIMITS;

function buildClaudeStreamJsonRunContext(runId: string): PreparedCliRunContext {
  const context = buildContext(runId);
  Object.assign(context.preparedBackend.backend, {
    serialize: false,
    jsonlDialect: "claude-stream-json",
  });
  context.params.timeoutMs = 60_000;
  return context;
}

beforeEach(() => {
  resetAgentEventsForTest();
  resetDiagnosticEventsForTest();
  supervisorSpawnMock.mockReset();
  const registry = createEmptyPluginRegistry();
  registry.providers.push({
    pluginId: "fixture-cli-provider",
    provider: {
      id: "fixture-cli-provider",
      label: "Fixture CLI provider",
      hookAliases: ["claude-cli"],
      auth: [],
    },
    source: "test",
  });
  setActivePluginRegistry(registry);
});

describe("CLI stream-json output limit", () => {
  it.each(["before", "after"] as const)(
    "stops a supervised CLI when the line limit trips %s spawn settles",
    async (when) => {
      const waiting = createDeferred();
      const exited = createDeferred();
      const cancelledExit = {
        ...createSuccessfulProcessExit(),
        reason: "manual-cancel" as const,
        exitCode: null,
        exitSignal: "SIGKILL" as const,
      };
      const managedRun = createManagedRun(cancelledExit);
      managedRun.wait.mockImplementation(async () => {
        waiting.resolve();
        await exited.promise;
        return cancelledExit;
      });
      managedRun.cancel.mockImplementation(() => exited.resolve());
      let spawnInput: SupervisorSpawnInput | undefined;
      const oversizedLine = "x".repeat(maxPendingLineChars + 1);
      supervisorSpawnMock.mockImplementationOnce(async (input) => {
        spawnInput = input;
        if (when === "before") {
          spawnInput.onStdout?.(oversizedLine);
        }
        return managedRun;
      });

      const run = runPreparedCliAgent(buildClaudeStreamJsonRunContext(`run-limit-${when}`));
      if (when === "after") {
        await waiting.promise;
        spawnInput?.onStdout?.(oversizedLine);
      }

      const failure = expect(run).rejects.toMatchObject({
        name: "FailoverError",
        reason: "format",
        message: `CLI JSONL line exceeded ${maxPendingLineChars} characters; refusing to parse output.`,
      });
      await waiting.promise;
      try {
        expect(managedRun.cancel).toHaveBeenCalledWith("manual-cancel");
      } finally {
        // Let the baseline finish too; a missing cancel must fail without hanging.
        exited.resolve();
        await failure;
      }
    },
  );

  it.each(["with result", "without result"] as const)(
    "waits for a plugin-owned turn %s after the cumulative output limit",
    async (mode) => {
      const context = buildClaudeStreamJsonRunContext("run-limit-plugin");
      context.params.persistStoppedFirstCliSession = vi.fn();
      vi.spyOn(cliTranscript, "claudeCliSessionTranscriptHasContent").mockResolvedValue(true);
      const record = {
        type: "system",
        subtype: "fixture_padding",
        padding: "x".repeat(1024 * 1024),
      };
      let yielded = 0;
      let drained = false;
      let closed = false;
      context.preparedBackend.backend.command = process.execPath;
      context.executionTarget = {
        kind: "plugin",
        async *execute() {
          try {
            yield { type: "system", subtype: "init", session_id: "native-first-turn" };
            while (yielded < 12) {
              yielded += 1;
              yield record;
            }
            if (mode === "with result") {
              yield { type: "result", subtype: "success", is_error: false, result: "done" };
            }
            drained = true;
          } finally {
            closed = true;
          }
        },
      };

      const outcome = await runPreparedCliAgent(context).catch((error: unknown) => error);
      if (mode === "with result") {
        expect(outcome).toMatchObject({
          payloads: [{ text: "done" }],
          meta: { agentMeta: { sessionId: "native-first-turn" }, finalAssistantRawText: "done" },
        });
      } else {
        expect(outcome).toMatchObject({
          name: "FailoverError",
          reason: "format",
          message: `CLI JSONL output exceeded ${maxTurnRawChars} characters; refusing to parse output.`,
        });
        expect(hasModelFallbackStop(outcome)).toBe(false);
        expect(context.params.persistStoppedFirstCliSession).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: "native-first-turn" }),
        );
      }
      expect(yielded).toBe(12);
      expect(drained).toBe(true);
      expect(closed).toBe(true);
    },
  );

  it("stops model fallback when a turn that already ran a tool exceeds the output limit", async () => {
    const context = buildClaudeStreamJsonRunContext("run-limit-after-tool");
    const tool = { type: "tool_use", id: "toolu-1", name: "exec", input: { command: "true" } };
    const result = { type: "tool_result", tool_use_id: "toolu-1", content: "ok" };
    const padding = { type: "system", subtype: "fixture_padding", padding: "x".repeat(1 << 20) };
    context.preparedBackend.backend.command = process.execPath;
    context.executionTarget = {
      kind: "plugin",
      async *execute() {
        yield { type: "assistant", message: { id: "msg-1", role: "assistant", content: [tool] } };
        yield { type: "user", message: { role: "user", content: [result] } };
        for (let i = 0; i < 12; i += 1) {
          yield padding;
        }
      },
    };

    const failure = await runPreparedCliAgent(context).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      message: expect.stringContaining("CLI JSONL output exceeded"),
    });
    // Another model replaying the prompt would run the completed tool again (#200744).
    expect(hasModelFallbackStop(failure)).toBe(true);
  });
});
