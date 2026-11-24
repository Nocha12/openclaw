import { describe, expect, it } from "vitest";
import {
  type DeferredPluginMigration,
  sameDeferredPluginMigrationInputs,
} from "./deferred-plugin-migrations.contract.js";

describe("sameDeferredPluginMigrationInputs", () => {
  const pending: DeferredPluginMigration = {
    pluginId: "fixture-plugin",
    reason: "Stored migration guidance",
    command: "openclaw doctor --fix",
    requiresStateMigration: true,
    configPaths: [["plugins", "entries", "fixture-plugin", "config"]],
  };

  it("ignores absent optional fields, extra metadata, and guidance differences", () => {
    const fromFacts = {
      ...pending,
      reason: "Updated migration guidance",
      command: "openclaw update repair",
      requiresDoctorInspection: undefined,
      validationExcludedPaths: undefined,
      status: "pending",
    };

    expect(sameDeferredPluginMigrationInputs([pending], [fromFacts])).toBe(true);
    expect(sameDeferredPluginMigrationInputs([fromFacts], [pending])).toBe(true);
  });

  it("still detects changed obligations and duplicate rows", () => {
    expect(
      sameDeferredPluginMigrationInputs([pending], [{ ...pending, requiresDoctorInspection: true }]),
    ).toBe(false);
    expect(
      sameDeferredPluginMigrationInputs([pending], [{ ...pending, configPaths: [] }]),
    ).toBe(false);
    expect(sameDeferredPluginMigrationInputs([pending], [pending, pending])).toBe(false);
  });
});
