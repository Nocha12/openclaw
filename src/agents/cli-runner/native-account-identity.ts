import fs from "node:fs";
import path from "node:path";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "../../../packages/normalization-core/src/string-coerce.js";
import { resolveOsHomeRelativePath } from "../../infra/home-dir.js";
import { loadJsonFileThroughSymlink } from "../../infra/json-file.js";

/** Account Claude Code reports for its own OAuth login in one config directory. */
export type CliNativeAccountIdentity = {
  kind: "claude-native-oauth";
  configDir: string;
  accountUuid: string;
  organizationUuid?: string;
  emailAddress?: string;
};

/**
 * Any of these in the spawned environment makes Claude authenticate with something other
 * than the config directory's OAuth login, so that login no longer names the account.
 */
const CLAUDE_NON_NATIVE_AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_OLD",
  "ANTHROPIC_API_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
  // Credentials from an independent store are not described by this config's oauthAccount.
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
] as const;

export type ClaudeNativeAccountEnvSources = {
  processEnv: NodeJS.ProcessEnv;
  /** Keys the runner deletes from the inherited environment. */
  clearEnv?: readonly string[];
  /** Cleared keys an operator explicitly keeps. */
  preservedEnv?: ReadonlySet<string>;
  /** Backend config env and per-run prepared env, applied over the inherited environment. */
  overrides?: ReadonlyArray<Readonly<Record<string, string | undefined>> | undefined>;
};

/** Environment the Claude child process sees for auth selection, without secret values. */
function resolveEffectiveEnv(sources: ClaudeNativeAccountEnvSources): Map<string, string> {
  const cleared = new Set(sources.clearEnv ?? []);
  const env = new Map<string, string>();
  for (const [key, value] of Object.entries(sources.processEnv)) {
    if (value === undefined || (cleared.has(key) && !sources.preservedEnv?.has(key))) {
      continue;
    }
    env.set(key, value);
  }
  for (const override of sources.overrides ?? []) {
    for (const [key, value] of Object.entries(override ?? {})) {
      if (value !== undefined) {
        env.set(key, value);
      }
    }
  }
  return env;
}

function hasNonNativeAuthSettings(settingsPath: string): boolean {
  const settings = asNonArrayRecord(loadJsonFileThroughSymlink(settingsPath));
  if (typeof settings.apiKeyHelper === "string" && settings.apiKeyHelper.trim()) {
    return true;
  }
  const settingsEnv = asNonArrayRecord(settings.env);
  return CLAUDE_NON_NATIVE_AUTH_ENV_KEYS.some((key) => settingsEnv[key] !== undefined);
}

type CachedAccount = { key: string; identity: CliNativeAccountIdentity | undefined };
let accountCache: CachedAccount | undefined;

function readOauthAccount(configDir: string): CliNativeAccountIdentity | undefined {
  const accountPath = path.join(configDir, ".claude.json");
  let key: string;
  try {
    const stat = fs.statSync(accountPath);
    key = `${accountPath}\0${stat.mtimeMs}\0${stat.size}`;
  } catch {
    return undefined;
  }
  if (accountCache?.key === key) {
    return accountCache.identity;
  }
  const account = asNonArrayRecord(
    asNonArrayRecord(loadJsonFileThroughSymlink(accountPath)).oauthAccount,
  );
  const accountUuid = normalizeOptionalString(account.accountUuid);
  const organizationUuid = normalizeOptionalString(account.organizationUuid);
  const emailAddress = normalizeOptionalString(account.emailAddress);
  const identity: CliNativeAccountIdentity | undefined = accountUuid
    ? {
        kind: "claude-native-oauth",
        configDir,
        accountUuid,
        ...(organizationUuid ? { organizationUuid } : {}),
        ...(emailAddress ? { emailAddress } : {}),
      }
    : undefined;
  accountCache = { key, identity };
  return identity;
}

/**
 * Identify the account behind Claude Code's own login for transcript ownership. Returns
 * undefined unless the spawned process can only authenticate with that config directory's
 * OAuth login and Claude has recorded a stable account id for it. Never returns secrets.
 */
export function resolveClaudeNativeAccountIdentity(
  sources: ClaudeNativeAccountEnvSources & { cwd?: string },
): CliNativeAccountIdentity | undefined {
  try {
    const env = resolveEffectiveEnv(sources);
    if (CLAUDE_NON_NATIVE_AUTH_ENV_KEYS.some((key) => env.has(key))) {
      return undefined;
    }
    const configuredDir = env.get("CLAUDE_CONFIG_DIR");
    const homeDir = resolveOsHomeRelativePath("~");
    const configDir = configuredDir ? path.resolve(configuredDir) : homeDir;
    const settingsDir = configuredDir ? configDir : path.join(homeDir, ".claude");
    const settingsPaths = [
      path.join(settingsDir, "settings.json"),
      ...(sources.cwd
        ? [
            path.join(sources.cwd, ".claude", "settings.json"),
            path.join(sources.cwd, ".claude", "settings.local.json"),
          ]
        : []),
    ];
    if (settingsPaths.some(hasNonNativeAuthSettings)) {
      return undefined;
    }
    let canonicalDir = configDir;
    try {
      canonicalDir = fs.realpathSync(configDir);
    } catch {
      return undefined;
    }
    return readOauthAccount(canonicalDir);
  } catch {
    return undefined;
  }
}

/** Test seam: forget the parsed account file. */
export function resetClaudeNativeAccountIdentityCacheForTest(): void {
  accountCache = undefined;
}
