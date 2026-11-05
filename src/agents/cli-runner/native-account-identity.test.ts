import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  resetClaudeNativeAccountIdentityCacheForTest,
  resolveClaudeNativeAccountIdentity,
  type ClaudeNativeAccountSources,
} from "./native-account-identity.js";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-account-")));
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  resetClaudeNativeAccountIdentityCacheForTest();
});

let dirNumber = 0;
function freshDir(name: string): string {
  const dir = path.join(root, `${name}-${++dirNumber}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function configDir(account: Record<string, unknown> | undefined, settings?: unknown): string {
  const dir = freshDir("config");
  fs.writeFileSync(
    path.join(dir, ".claude.json"),
    JSON.stringify(account ? { oauthAccount: account, numStartups: 3 } : { numStartups: 3 }),
  );
  if (settings !== undefined) {
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      typeof settings === "string" ? settings : JSON.stringify(settings),
    );
  }
  return dir;
}
function resolve(sources: Partial<ClaudeNativeAccountSources> & { processEnv: NodeJS.ProcessEnv }) {
  return resolveClaudeNativeAccountIdentity({ managedSettingsRoots: [], ...sources });
}

const account = {
  accountUuid: "account-a",
  organizationUuid: "org-a",
  emailAddress: "owner@example.test",
};

describe("resolveClaudeNativeAccountIdentity", () => {
  it("names the account Claude recorded for the inherited config root", () => {
    const dir = configDir(account);
    expect(resolve({ processEnv: { CLAUDE_CONFIG_DIR: dir }, command: "/opt/bin/claude" })).toEqual(
      {
        identity: {
          kind: "claude-native-oauth",
          configDir: dir,
          configDirSelector: dir,
          ...account,
        },
      },
    );
  });

  it("keeps the raw config selector next to the canonical directory", () => {
    const dir = configDir(account);
    const alias = path.join(root, `alias-${++dirNumber}`);
    fs.symlinkSync(dir, alias);
    const viaAlias = resolve({ processEnv: { CLAUDE_CONFIG_DIR: alias } }).identity;
    expect(viaAlias?.configDir).toBe(dir);
    // Claude keys its credential store by the raw selector, so the alias is a different login.
    expect(viaAlias?.configDirSelector).toBe(alias);
  });

  it("follows the config root the child actually receives", () => {
    const inherited = configDir(account);
    const configured = configDir({ ...account, accountUuid: "account-b" });
    expect(
      resolve({
        processEnv: { CLAUDE_CONFIG_DIR: inherited },
        overrides: [{ CLAUDE_CONFIG_DIR: configured }],
      }).identity?.accountUuid,
    ).toBe("account-b");
  });

  it("re-reads the account after Claude switches login", () => {
    const dir = configDir(account);
    const env = { processEnv: { CLAUDE_CONFIG_DIR: dir } };
    expect(resolve(env).identity?.accountUuid).toBe("account-a");
    fs.writeFileSync(
      path.join(dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "account-b" } }),
    );
    expect(resolve(env).identity?.accountUuid).toBe("account-b");
  });

  it("refuses without a recorded account id or a usable config root", () => {
    expect(
      resolve({ processEnv: { CLAUDE_CONFIG_DIR: configDir({ emailAddress: "a@example.test" }) } }),
    ).toEqual({ refused: "no-recorded-account" });
    expect(resolve({ processEnv: { CLAUDE_CONFIG_DIR: configDir(undefined) } })).toEqual({
      refused: "no-recorded-account",
    });
    expect(resolve({ processEnv: { CLAUDE_CONFIG_DIR: path.join(root, "missing") } })).toEqual({
      refused: "config-dir-missing",
    });
    for (const selector of ["relative/claude", ""]) {
      expect(resolve({ processEnv: { CLAUDE_CONFIG_DIR: selector } })).toEqual({
        refused: "config-dir-not-absolute",
      });
    }
  });

  it("refuses a wrapper command that may log in anywhere", () => {
    const dir = configDir(account);
    expect(resolve({ processEnv: { CLAUDE_CONFIG_DIR: dir }, command: "/usr/bin/ssh" })).toEqual({
      refused: "custom-command",
    });
  });

  it.each([
    ["API key", "ANTHROPIC_API_KEY"],
    ["custom auth header", "ANTHROPIC_CUSTOM_HEADERS"],
    ["unknown Anthropic override", "ANTHROPIC_FUTURE_ROUTE"],
    ["OAuth token", "CLAUDE_CODE_OAUTH_TOKEN"],
    ["token descriptor", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"],
    ["gateway endpoint", "ANTHROPIC_BASE_URL"],
    ["cloud provider", "CLAUDE_CODE_USE_BEDROCK"],
    ["future cloud provider", "CLAUDE_CODE_USE_SOMETHING"],
    ["independent credential store", "CLAUDE_SECURESTORAGE_CONFIG_DIR"],
  ])("refuses when the child can authenticate another way: %s", (_name, key) => {
    const dir = configDir(account);
    for (const sources of [
      { processEnv: { CLAUDE_CONFIG_DIR: dir }, overrides: [{ [key]: "synthetic" }] },
      { processEnv: { CLAUDE_CONFIG_DIR: dir }, overrides: [{ [` ${key} `]: "synthetic" }] },
      { processEnv: { CLAUDE_CONFIG_DIR: dir, [key]: "synthetic" } },
    ]) {
      expect(resolve(sources)).toEqual({ refused: `env:${key}` });
    }
  });

  it("allows model selection env", () => {
    const dir = configDir(account);
    expect(
      resolve({ processEnv: { CLAUDE_CONFIG_DIR: dir, ANTHROPIC_MODEL: "opus" } }).identity
        ?.accountUuid,
    ).toBe("account-a");
  });

  it("ignores inherited overrides the runner clears, unless an operator preserves them", () => {
    const dir = configDir(account);
    const processEnv = { CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: "synthetic" };
    expect(resolve({ processEnv, clearEnv: ["ANTHROPIC_API_KEY"] }).identity?.accountUuid).toBe(
      "account-a",
    );
    expect(
      resolve({
        processEnv,
        clearEnv: ["ANTHROPIC_API_KEY"],
        preservedEnv: new Set(["ANTHROPIC_API_KEY"]),
      }),
    ).toEqual({ refused: "env:ANTHROPIC_API_KEY" });
  });

  it("refuses an apiKeyHelper, auth env, or unreadable file in user settings", () => {
    for (const [settings, reason] of [
      [{ apiKeyHelper: "print-key" }, "settings-api-key-helper:settings.json"],
      [{ env: { ANTHROPIC_AUTH_TOKEN: "synthetic" } }, "settings-env:ANTHROPIC_AUTH_TOKEN"],
      ["{ not json", "unreadable-settings:settings.json"],
    ] as const) {
      const dir = configDir(account, settings);
      expect(resolve({ processEnv: { CLAUDE_CONFIG_DIR: dir } })).toEqual({ refused: reason });
    }
    const dir = configDir(account, { env: { ANTHROPIC_MODEL: "opus" }, model: "opus" });
    expect(resolve({ processEnv: { CLAUDE_CONFIG_DIR: dir } }).identity).toBeDefined();
  });

  it("refuses project and managed policy settings that redirect auth", () => {
    const cwd = freshDir("project");
    fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".claude", "settings.local.json"),
      JSON.stringify({ apiKeyHelper: "print-key" }),
    );
    expect(resolve({ processEnv: { CLAUDE_CONFIG_DIR: configDir(account) }, cwd })).toEqual({
      refused: "settings-api-key-helper:settings.local.json",
    });

    const managed = freshDir("managed");
    fs.mkdirSync(path.join(managed, "managed-settings.d"));
    fs.writeFileSync(
      path.join(managed, "managed-settings.d", "10-org.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://proxy.example.test" } }),
    );
    expect(
      resolve({
        processEnv: { CLAUDE_CONFIG_DIR: configDir(account) },
        managedSettingsRoots: [managed],
      }),
    ).toEqual({ refused: "settings-env:ANTHROPIC_BASE_URL" });
    fs.writeFileSync(
      path.join(managed, "managed-settings.json"),
      JSON.stringify({ apiKeyHelper: "x" }),
    );
    expect(
      resolve({
        processEnv: { CLAUDE_CONFIG_DIR: configDir(account) },
        managedSettingsRoots: [managed],
      }),
    ).toEqual({ refused: "settings-api-key-helper:managed-settings.json" });
  });
});
