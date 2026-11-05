import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  resetClaudeNativeAccountIdentityCacheForTest,
  resolveClaudeNativeAccountIdentity,
} from "./native-account-identity.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-account-"));
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  resetClaudeNativeAccountIdentityCacheForTest();
});

let dirNumber = 0;
function configDir(account: Record<string, unknown> | undefined, settings?: unknown): string {
  const dir = path.join(root, `config-${++dirNumber}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".claude.json"),
    JSON.stringify(account ? { oauthAccount: account, numStartups: 3 } : { numStartups: 3 }),
  );
  if (settings !== undefined) {
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
  }
  return fs.realpathSync(dir);
}

const account = {
  accountUuid: "account-a",
  organizationUuid: "org-a",
  emailAddress: "owner@example.test",
};

describe("resolveClaudeNativeAccountIdentity", () => {
  it("names the account Claude recorded for the inherited config root", () => {
    const dir = configDir(account);
    expect(resolveClaudeNativeAccountIdentity({ processEnv: { CLAUDE_CONFIG_DIR: dir } })).toEqual({
      kind: "claude-native-oauth",
      configDir: dir,
      ...account,
    });
  });

  it("follows the config root the child actually receives", () => {
    const inherited = configDir(account);
    const configured = configDir({ ...account, accountUuid: "account-b" });
    expect(
      resolveClaudeNativeAccountIdentity({
        processEnv: { CLAUDE_CONFIG_DIR: inherited },
        overrides: [{ CLAUDE_CONFIG_DIR: configured }],
      })?.accountUuid,
    ).toBe("account-b");
  });

  it("re-reads the account after Claude switches login", () => {
    const dir = configDir(account);
    const env = { processEnv: { CLAUDE_CONFIG_DIR: dir } };
    expect(resolveClaudeNativeAccountIdentity(env)?.accountUuid).toBe("account-a");
    fs.writeFileSync(
      path.join(dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "account-b-longer" } }),
    );
    expect(resolveClaudeNativeAccountIdentity(env)?.accountUuid).toBe("account-b-longer");
  });

  it("returns nothing without a recorded account id", () => {
    expect(
      resolveClaudeNativeAccountIdentity({
        processEnv: { CLAUDE_CONFIG_DIR: configDir({ emailAddress: "owner@example.test" }) },
      }),
    ).toBeUndefined();
    expect(
      resolveClaudeNativeAccountIdentity({
        processEnv: { CLAUDE_CONFIG_DIR: configDir(undefined) },
      }),
    ).toBeUndefined();
    expect(
      resolveClaudeNativeAccountIdentity({
        processEnv: { CLAUDE_CONFIG_DIR: path.join(root, "missing") },
      }),
    ).toBeUndefined();
  });

  it.each([
    ["API key", { ANTHROPIC_API_KEY: "synthetic" }],
    ["OAuth token", { CLAUDE_CODE_OAUTH_TOKEN: "synthetic" }],
    ["token descriptor", { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3" }],
    ["gateway endpoint", { ANTHROPIC_BASE_URL: "https://example.test" }],
    ["cloud provider", { CLAUDE_CODE_USE_BEDROCK: "1" }],
    ["independent credential store", { CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }],
  ])("refuses when the child can authenticate another way: %s", (_name, env) => {
    const dir = configDir(account);
    expect(
      resolveClaudeNativeAccountIdentity({
        processEnv: { CLAUDE_CONFIG_DIR: dir },
        overrides: [env],
      }),
    ).toBeUndefined();
    expect(
      resolveClaudeNativeAccountIdentity({ processEnv: { CLAUDE_CONFIG_DIR: dir, ...env } }),
    ).toBeUndefined();
  });

  it("ignores inherited overrides the runner clears, unless an operator preserves them", () => {
    const dir = configDir(account);
    const processEnv = { CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: "synthetic" };
    expect(
      resolveClaudeNativeAccountIdentity({ processEnv, clearEnv: ["ANTHROPIC_API_KEY"] })
        ?.accountUuid,
    ).toBe("account-a");
    expect(
      resolveClaudeNativeAccountIdentity({
        processEnv,
        clearEnv: ["ANTHROPIC_API_KEY"],
        preservedEnv: new Set(["ANTHROPIC_API_KEY"]),
      }),
    ).toBeUndefined();
  });

  it("refuses an apiKeyHelper or auth env in Claude settings", () => {
    for (const settings of [
      { apiKeyHelper: "print-key" },
      { env: { ANTHROPIC_AUTH_TOKEN: "synthetic" } },
    ]) {
      const dir = configDir(account, settings);
      expect(
        resolveClaudeNativeAccountIdentity({ processEnv: { CLAUDE_CONFIG_DIR: dir } }),
      ).toBeUndefined();
    }
    const cwd = path.join(root, "project");
    fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".claude", "settings.local.json"),
      JSON.stringify({ apiKeyHelper: "print-key" }),
    );
    expect(
      resolveClaudeNativeAccountIdentity({
        processEnv: { CLAUDE_CONFIG_DIR: configDir(account) },
        cwd,
      }),
    ).toBeUndefined();
  });
});
