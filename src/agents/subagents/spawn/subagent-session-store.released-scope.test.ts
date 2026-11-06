import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { writeSessionEntry } from "../../../config/sessions/session-accessor.sqlite-entry-store.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { enqueueCommandInLane } from "../../../process/command-queue.js";
import {
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} from "../../../state/openclaw-agent-db.js";
import { resolveStoredSubagentCapabilities as resolveCapabilities } from "./subagent-capabilities.js";
import { getSubagentDepthFromSessionStoreInWorker } from "./subagent-depth.js";
import {
  createSubagentSessionStore,
  prepareSessionCapabilityRead,
  SessionCapabilityMetadataChangedError,
  withPreparedSessionCapabilityRead,
} from "./subagent-session-store.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const dir of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
    }
    cleanup();
  }),
);

const parent = "agent:main:main";
const child = "agent:main:subagent:child";

function writeEntries(storePath: string, entries: Record<string, SessionEntry>) {
  runOpenClawAgentWriteTransaction(
    (database) => {
      for (const [key, value] of Object.entries(entries)) {
        writeSessionEntry(database, key, value);
      }
    },
    { agentId: "main", path: storePath },
  );
}

function seed(prefix: string) {
  const storePath = path.join(tempDirs.make(prefix), "sessions.sqlite");
  writeEntries(storePath, {
    [parent]: { sessionId: "parent", updatedAt: 1 },
    // No stored depth: resolving it walks to the parent row, like a real requester chain.
    [child]: { sessionId: "child", updatedAt: 1, spawnedBy: parent },
  });
  return { storePath, cfg: { session: { store: storePath } } };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/** An MCP tool request retains its requester facts, then queues work that outlives it. */
async function queueFromRetainedRequest<T>(
  storePath: string,
  queue: (work: () => Promise<T>) => Promise<T>,
  work: () => Promise<T>,
  whileRetained?: () => void,
) {
  const gate = deferred();
  let queued!: Promise<T>;
  await withPreparedSessionCapabilityRead(
    () => {
      createSubagentSessionStore(storePath, "main").get(parent);
      return (async () => {
        queued = queue(async () => {
          await gate.promise;
          return work();
        });
        whileRetained?.();
      })();
    },
    { retain: true },
  );
  return { queued, open: gate.resolve };
}

describe("capability reads inherited by queued work", () => {
  it("prepares current facts after the enqueuing request released its readers", async () => {
    const { storePath, cfg } = seed("capability-released-lane-");
    const { queued, open } = await queueFromRetainedRequest(
      storePath,
      (work) => enqueueCommandInLane("capability-released-lane", work),
      () => getSubagentDepthFromSessionStoreInWorker(child, { cfg }),
    );
    open();
    // Before the fix this failed with
    // "Session capability metadata changed | Session capability metadata requires worker preparation".
    await expect(queued).resolves.toBe(1);
  });

  it("keeps detached retry timers usable after the request released its readers", async () => {
    const { storePath, cfg } = seed("capability-released-timer-");
    const { queued, open } = await queueFromRetainedRequest(
      storePath,
      (work) =>
        new Promise((resolve, reject) => {
          setTimeout(() => void work().then(resolve, reject), 0);
        }),
      () => getSubagentDepthFromSessionStoreInWorker(child, { cfg }),
    );
    open();
    await expect(queued).resolves.toBe(1);
  });

  it("does not bypass a capability change made while the request still holds its facts", async () => {
    const { storePath, cfg } = seed("capability-revoked-");
    const gate = deferred();
    let queued!: Promise<number>;
    const request = withPreparedSessionCapabilityRead(
      () => {
        createSubagentSessionStore(storePath, "main").get(parent);
        return (async () => {
          queued = enqueueCommandInLane("capability-revoked-lane", async () => {
            await gate.promise;
            return getSubagentDepthFromSessionStoreInWorker(child, { cfg });
          });
          writeEntries(storePath, {
            [parent]: { sessionId: "parent", updatedAt: 2, spawnDepth: 4 },
          });
          gate.resolve();
          await settle(queued);
        })();
      },
      { retain: true },
    );
    await request;
    const outcome = await settle(queued);
    expect(outcome.ok).toBe(false);
    const error = (outcome as { error: unknown }).error;
    expect(error).toBeInstanceOf(SessionCapabilityMetadataChangedError);
    expect(error).toMatchObject({
      message: "Session capability metadata changed",
      target: parent,
      reason: "facts-changed",
      changedFields: ["spawnDepth"],
    });
  });

  it("lets a retained read started inside a live request outlive that request", async () => {
    const { storePath, cfg } = seed("capability-outliving-retained-");
    const depth = () => resolveCapabilities(child, { cfg }).depth;
    let inner: Awaited<ReturnType<typeof prepareSessionCapabilityRead<number>>> | undefined;
    await withPreparedSessionCapabilityRead(
      () => {
        createSubagentSessionStore(storePath, "main").get(parent);
        // Like a queued run an idle lane starts before the enqueuing request returns.
        return (async () => {
          inner = await prepareSessionCapabilityRead(depth);
        })();
      },
      { retain: true },
    );
    const retained = expectDefinedRead(inner);
    try {
      expect(retained.read()).toBe(1);
      writeEntries(storePath, {
        [parent]: { sessionId: "parent", updatedAt: 2, spawnDepth: 4 },
      });
      // Its own guard still sees later changes to the facts it consumed.
      expect(() => retained.read()).toThrow("Session capability metadata changed");
    } finally {
      retained.release();
    }
  });

  it("lets an ordinary read that started inside a live request finish after it", async () => {
    const { cfg } = seed("capability-outliving-ordinary-");
    const depth = () => resolveCapabilities(child, { cfg }).depth;
    const gate = deferred();
    let inner: Promise<unknown> | undefined;
    await withPreparedSessionCapabilityRead(
      () => {
        expect(depth()).toBe(1);
        return (async () => {
          inner = withPreparedSessionCapabilityRead(async () => {
            const before = depth();
            await gate.promise;
            return [before, depth()];
          });
        })();
      },
      { retain: true },
    );
    gate.resolve();
    await expect(expectDefinedRead(inner)).resolves.toEqual([1, 1]);
  });

  it("still refuses a retained replay once its own request released it", async () => {
    const { cfg } = seed("capability-own-release-");
    const prepared = await prepareSessionCapabilityRead(
      () => resolveCapabilities(child, { cfg }).depth,
    );
    expect(prepared.read()).toBe(1);
    prepared.release();
    expect(() => prepared.read()).toThrow("Session capability read is no longer active");
  });
});

function expectDefinedRead<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}
