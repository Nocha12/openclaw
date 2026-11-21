import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { SqliteSnapshotCapacityError } from "../../infra/sqlite-snapshot-capacity-error.js";
import * as snapshots from "../../infra/sqlite-snapshot-source.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createStatusCommand } from "./status.gather.service-inspection.test-support.js";

export function registerStatusDatabaseRecoveryTests(params: {
  makeTempDir: (prefix: string) => string;
  useRealSchemaPreflight: (env: Record<string, string>) => Promise<void>;
  createConfigIOCalls: { mock: { calls: unknown[][] } };
}) {
  it.each([
    undefined,
    new SqliteSnapshotCapacityError("snapshot storage unavailable (code=ENOSPC)"),
    new Error("database disk image is malformed"),
    Object.assign(new Error("disk I/O error"), { errcode: 778 }),
    new AggregateError([new SqliteSnapshotCapacityError("disk full"), new Error("cleanup failed")]),
  ])("reports state inspection recovery instead of a config read failure (%s)", async (failure) => {
    const stateDir = params.makeTempDir("openclaw-status-unreadable-state-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = resolveOpenClawStateSqlitePath(env);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.writeFile(databasePath, "not a sqlite database ".repeat(256));
    const before = await fs.readFile(databasePath);
    await params.useRealSchemaPreflight(env);
    if (failure) {
      const snapshot = vi
        .spyOn(snapshots, "prepareSqliteReadOnlyLocation")
        .mockRejectedValueOnce(failure);
      onTestFinished(() => snapshot.mockRestore());
    }
    const { program, writeJson, exit } = createStatusCommand();
    await expect(
      program
        .parseAsync(["gateway", "status", "--deep", "--no-probe", "--json"], { from: "user" })
        .then(() => undefined),
    ).rejects.toThrow("status-exit");
    const output = JSON.stringify(writeJson.mock.calls);
    expect(output).toContain(
      failure
        ? `shared state database inspection ${"errcode" in failure ? "did not complete" : "was interrupted"} at ${databasePath}`
        : `shared state database is unreadable at ${databasePath}`,
    );
    expect(output).toContain(
      failure ? "rerun the command" : "restore this file from a verified backup",
    );
    if (failure) {
      expect(output).not.toContain("restore this file");
    }
    expect(output).not.toContain("CONFIG_READ_FAILED");
    expect(exit).toHaveBeenCalledWith(1);
    expect(params.createConfigIOCalls).not.toHaveBeenCalled();
    expect(await fs.readFile(databasePath)).toEqual(before);
  });
}
