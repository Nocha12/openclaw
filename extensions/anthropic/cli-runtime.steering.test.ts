import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionHandle,
  CliBackendSteeringCapability,
  CliBackendSteeringSink,
} from "openclaw/plugin-sdk/cli-backend";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  withinTest,
  type FixtureReceiptChannel,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CLAUDE_PROTOCOL_FIXTURE } from "./cli-runtime.test-support.js";
import { executeClaudeCli } from "./cli.runtime.js";

const roots: string[] = [];
const handles = new Set<CliBackendLiveSessionHandle>();
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});
afterEach(async () => {
  for (const handle of handles) {
    handle.close("restart");
    await handle.waitForExit();
  }
  handles.clear();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createLiveSession(): CliBackendLiveSessionCapability {
  let current: CliBackendLiveSessionHandle | undefined;
  return {
    fingerprint: "synthetic-process-policy",
    current: () => current,
    restart: async () => {
      const previous = current;
      previous?.close("restart");
      await previous?.waitForExit();
    },
    register: (handle) => {
      current = handle;
      handles.add(handle);
    },
    activate: () => {},
    remove: (handle) => {
      if (current === handle) {
        current = undefined;
      }
    },
  };
}

async function createContext(
  scenario: string,
  overrides: Partial<CliBackendExecuteContext> = {},
): Promise<CliBackendExecuteContext> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-steer-")));
  roots.push(root);
  const fixture = path.join(root, "claude.mjs");
  await writeFile(
    fixture,
    `${fixtureReceiptClientSource(receipts.endpoint)}
${CLAUDE_PROTOCOL_FIXTURE}`,
  );
  return {
    command: process.execPath,
    args: [fixture],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      CLAUDE_CONFIG_DIR: root,
      CLAUDE_FIXTURE_SCENARIO: scenario,
    },
    prompt: "synthetic user input",
    systemPrompt: "synthetic operator instructions",
    modelId: "claude-sonnet-4-6",
    useResume: false,
    liveSession: createLiveSession(),
    timeoutMs: 10_000,
    abortSignal: AbortSignal.timeout(10_000),
    requestToolPermission: vi.fn<CliBackendExecuteContext["requestToolPermission"]>(async () => ({
      behavior: "deny",
      message: "Fixture denied.",
    })),
    requestUserInput: vi.fn<CliBackendExecuteContext["requestUserInput"]>(async () => ({
      status: "cancelled",
      message: "No question expected.",
    })),
    ...overrides,
  };
}

async function collect(context: CliBackendExecuteContext) {
  const records: Record<string, unknown>[] = [];
  for await (const record of executeClaudeCli(context)) {
    records.push(record);
  }
  return records;
}

function resultDetail(records: Record<string, unknown>[]): Record<string, unknown> {
  const result = records.findLast((record) => record.type === "result");
  expect(result).toEqual(
    expect.objectContaining({ subtype: "success", result: expect.any(String) }),
  );
  return JSON.parse(String(result?.result)) as Record<string, unknown>;
}

function createSteering() {
  let sink: CliBackendSteeringSink | undefined;
  const detach = vi.fn();
  const attach = vi.fn<CliBackendSteeringCapability["attach"]>((next) => {
    sink = next;
    return () => {
      sink = undefined;
      detach();
    };
  });
  return {
    capability: { attach } satisfies CliBackendSteeringCapability,
    attach,
    detach,
    current: () => sink,
  };
}

async function startSteeredTurn(scenario: string, signal: AbortSignal) {
  const steering = createSteering();
  const context = await createContext(scenario, { steering: steering.capability });
  const running = collect(context);
  void running.catch(() => {});
  await withinTest(receipts.waitFor(path.join(context.cwd, "steer.ready"), "ready"), signal);
  const sink = steering.current();
  expect(sink).toBeDefined();
  return { steering, context, running, sink: sink! };
}

describe("Claude CLI parent steering", () => {
  it("writes steering into the running native turn and reports its native lifecycle", async ({
    signal,
  }) => {
    const { steering, running, sink } = await startSteeredTurn("steer", signal);
    await vi.waitFor(() => expect(sink.isAvailable()).toBe(true));
    const states: string[] = [];
    const onQueued = vi.fn();
    const assertCurrent = vi.fn();
    const delivered = await sink.deliver({
      text: "/clear use plan B",
      assertCurrent,
      onQueued,
      onState: (_id, state) => states.push(state),
    });
    expect(delivered.acknowledged).toBe(true);
    const records = await running;
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(onQueued).toHaveBeenCalledWith(delivered.id);
    expect(states).toEqual(["consumed", "completed"]);
    expect(records.filter((record) => record.type === "result")).toHaveLength(1);
    expect(resultDetail(records)).toMatchObject({
      steerUuid: delivered.id,
      steerParent: null,
      steerCount: 1,
      // The fixed header keeps a leading slash command inert.
      steerText: "[Message received while this turn was running]\n/clear use plan B",
    });
    expect(steering.detach).toHaveBeenCalledOnce();
    expect(sink.isAvailable()).toBe(false);
  });

  it("holds the first result until steering queued behind it runs as its own query", async ({
    signal,
  }) => {
    const { running, sink } = await startSteeredTurn("steer-after-result", signal);
    await vi.waitFor(() => expect(sink.isAvailable()).toBe(true));
    const states: string[] = [];
    const delivered = await sink.deliver({
      text: "also check the logs",
      assertCurrent: () => {},
      onQueued: () => {},
      onState: (_id, state) => states.push(state),
    });
    expect(delivered.acknowledged).toBe(true);
    const records = await running;
    const results = records.filter((record) => record.type === "result");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ openclaw_interim_result: true });
    expect(results[1]).not.toHaveProperty("openclaw_interim_result");
    expect(resultDetail(records)).toMatchObject({ steerUuid: delivered.id });
    expect(states).toEqual(["consumed", "completed"]);
  });

  it("reports cancelled steering as dropped without holding the turn", async ({ signal }) => {
    const { running, sink } = await startSteeredTurn("steer-cancel", signal);
    await vi.waitFor(() => expect(sink.isAvailable()).toBe(true));
    const states: string[] = [];
    const delivered = await sink.deliver({
      text: "stop",
      assertCurrent: () => {},
      onQueued: () => {},
      onState: (_id, state) => states.push(state),
    });
    expect(delivered.acknowledged).toBe(false);
    expect(states).toEqual(["dropped"]);
    const records = await running;
    expect(resultDetail(records)).toMatchObject({ steerCancelled: true });
  });

  it("writes nothing when the host source check fails at the native effect", async ({ signal }) => {
    const { running, sink } = await startSteeredTurn("steer", signal);
    await vi.waitFor(() => expect(sink.isAvailable()).toBe(true));
    const onQueued = vi.fn();
    await expect(
      sink.deliver({
        text: "stale steering",
        assertCurrent: () => {
          throw new Error("Synthetic source revoked.");
        },
        onQueued,
        onState: () => {},
      }),
    ).rejects.toThrow("Synthetic source revoked.");
    expect(onQueued).not.toHaveBeenCalled();
    await expect(
      sink.deliver({ text: "", assertCurrent: () => {}, onQueued, onState: () => {} }),
    ).rejects.toThrow("not accepting steering");
    const delivered = await sink.deliver({
      text: "current steering",
      assertCurrent: () => {},
      onQueued,
      onState: () => {},
    });
    const records = await running;
    expect(resultDetail(records)).toMatchObject({
      steerUuid: delivered.id,
      steerCount: 1,
      steerText: "[Message received while this turn was running]\ncurrent steering",
    });
  });

  it("refuses steering when the native CLI has no input lifecycle", async ({ signal }) => {
    const { context, running, sink } = await startSteeredTurn("steer-legacy", signal);
    expect(sink.isAvailable()).toBe(false);
    await expect(
      sink.deliver({
        text: "hello",
        assertCurrent: () => {},
        onQueued: () => {},
        onState: () => {},
      }),
    ).rejects.toThrow("not accepting steering");
    await writeFile(path.join(context.cwd, "steer.release"), "release");
    expect(resultDetail(await running)).toMatchObject({ legacy: true });
  });

  it("never attaches steering to a side question", async () => {
    const steering = createSteering();
    const context = await createContext("normal", {
      steering: steering.capability,
      executionMode: "side-question",
    });
    await collect(context);
    expect(steering.attach).not.toHaveBeenCalled();
  });
});
