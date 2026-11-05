import fs from "node:fs";
import path from "node:path";
import { asNonArrayRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "../../../packages/normalization-core/src/string-coerce.js";
import { resolveOsHomeRelativePath } from "../../infra/home-dir.js";

/** Parsed JSON, or undefined when the file cannot be read or parsed. */
function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

/** Account Claude Code reports for its own OAuth login in one config directory. */
export type CliNativeAccountIdentity = {
  kind: "claude-native-oauth";
  /** Canonical directory holding `.claude.json`. */
  configDir: string;
  /** Raw `CLAUDE_CONFIG_DIR` the child sees; Claude keys its credential store by it. */
  configDirSelector: string | null;
  accountUuid: string;
  organizationUuid?: string;
  emailAddress?: string;
};

/**
 * Env that makes Claude authenticate with something other than the config directory's
 * OAuth login, so that login no longer names the account. Any other `ANTHROPIC_*` key
 * and every `CLAUDE_CODE_USE_*` provider switch is refused as well.
 */
const CLAUDE_NON_NATIVE_AUTH_ENV_KEYS = new Set([
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_REMOTE",
  // Credentials from an independent store are not described by this config's oauthAccount.
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
]);
/** Model selection only; these never choose an account, endpoint, or credential. */
const CLAUDE_MODEL_SELECTION_ENV_KEYS = new Set([
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
]);

function isNonNativeAuthEnvKey(key: string): boolean {
  return (
    CLAUDE_NON_NATIVE_AUTH_ENV_KEYS.has(key) ||
    key.startsWith("CLAUDE_CODE_USE_") ||
    (key.startsWith("ANTHROPIC_") && !CLAUDE_MODEL_SELECTION_ENV_KEYS.has(key))
  );
}

/** Policy files Claude always applies, whatever `--setting-sources` selects. */
function resolveManagedSettingsRoots(): string[] {
  switch (process.platform) {
    case "darwin":
      return ["/Library/Application Support/ClaudeCode"];
    case "win32":
      return [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "ClaudeCode")];
    default:
      return ["/etc/claude-code"];
  }
}

export type ClaudeNativeAccountSources = {
  processEnv: NodeJS.ProcessEnv;
  /** Keys the runner deletes from the inherited environment. */
  clearEnv?: readonly string[];
  /** Cleared keys an operator explicitly keeps. */
  preservedEnv?: ReadonlySet<string>;
  /** Backend config env and per-run prepared env, applied over the inherited environment. */
  overrides?: ReadonlyArray<Readonly<Record<string, string | undefined>> | undefined>;
  /** Executable the runner spawns; a wrapper may log in anywhere. */
  command?: string;
  /** Workspace the child runs in; project settings there apply to it. */
  cwd?: string;
  /** Test seam for the platform policy directories. */
  managedSettingsRoots?: readonly string[];
};

export type ClaudeNativeAccountResult =
  | { identity: CliNativeAccountIdentity; refused?: undefined }
  | { identity?: undefined; refused: string };

/** Environment the Claude child process sees for auth selection, without secret values. */
function resolveEffectiveEnv(sources: ClaudeNativeAccountSources): Map<string, string> {
  const cleared = new Set(sources.clearEnv ?? []);
  const env = new Map<string, string>();
  for (const [key, value] of Object.entries(sources.processEnv)) {
    if (value === undefined || (cleared.has(key) && !sources.preservedEnv?.has(key))) {
      continue;
    }
    env.set(key.trim(), value);
  }
  for (const override of sources.overrides ?? []) {
    for (const [key, value] of Object.entries(override ?? {})) {
      if (value !== undefined) {
        // The spawn sanitizer trims override keys before applying them.
        env.set(key.trim(), value);
      }
    }
  }
  return env;
}

function settingsFiles(file: string, dropInDir?: string): string[] {
  if (!dropInDir) {
    return [file];
  }
  let entries: string[] = [];
  try {
    entries = fs
      .readdirSync(dropInDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(dropInDir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return [file, ...entries];
}

/** Undefined when the file is absent and harmless; a reason when it can redirect auth. */
function inspectSettingsFile(settingsPath: string): string | undefined {
  if (!fs.existsSync(settingsPath)) {
    return undefined;
  }
  const settings = readJsonFile(settingsPath);
  // A file Claude may parse differently, or cannot read, is not proof of a clean policy.
  if (!isRecord(settings)) {
    return `unreadable-settings:${path.basename(settingsPath)}`;
  }
  if (settings.apiKeyHelper !== undefined) {
    return `settings-api-key-helper:${path.basename(settingsPath)}`;
  }
  const settingsEnv = asNonArrayRecord(settings.env);
  const key = Object.keys(settingsEnv).find((name) => isNonNativeAuthEnvKey(name.trim()));
  return key ? `settings-env:${key.trim()}` : undefined;
}

type CachedAccount = { key: string; account: Omit<CliNativeAccountIdentity, "configDirSelector"> };
let accountCache: CachedAccount | undefined;

function readOauthAccount(
  configDir: string,
): Omit<CliNativeAccountIdentity, "configDirSelector"> | undefined {
  const accountPath = path.join(configDir, ".claude.json");
  let key: string;
  try {
    const stat = fs.statSync(accountPath);
    key = [accountPath, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join("\0");
  } catch {
    return undefined;
  }
  if (accountCache?.key === key) {
    return accountCache.account;
  }
  const account = asNonArrayRecord(asNonArrayRecord(readJsonFile(accountPath)).oauthAccount);
  const accountUuid = normalizeOptionalString(account.accountUuid);
  if (!accountUuid) {
    return undefined;
  }
  const organizationUuid = normalizeOptionalString(account.organizationUuid);
  const emailAddress = normalizeOptionalString(account.emailAddress);
  const parsed = {
    kind: "claude-native-oauth" as const,
    configDir,
    accountUuid,
    ...(organizationUuid ? { organizationUuid } : {}),
    ...(emailAddress ? { emailAddress } : {}),
  };
  accountCache = { key, account: parsed };
  return parsed;
}

/**
 * Identify the account behind Claude Code's own login for transcript ownership. Succeeds
 * only when the spawned process can authenticate with nothing but that config directory's
 * OAuth login and Claude has recorded a stable account id for it. Never returns secrets;
 * a refusal names only the env key, settings file, or condition that blocked it.
 */
export function resolveClaudeNativeAccountIdentity(
  sources: ClaudeNativeAccountSources,
): ClaudeNativeAccountResult {
  try {
    const command = sources.command?.trim();
    if (command && !/^claude(?:\.exe|\.cmd)?$/iu.test(path.basename(command))) {
      return { refused: "custom-command" };
    }
    const env = resolveEffectiveEnv(sources);
    const envKey = [...env.keys()].find(isNonNativeAuthEnvKey);
    if (envKey) {
      return { refused: `env:${envKey}` };
    }
    const selector = env.get("CLAUDE_CONFIG_DIR");
    // The child resolves a relative root against its own cwd; an empty one is ambiguous.
    if (selector !== undefined && !path.isAbsolute(selector)) {
      return { refused: "config-dir-not-absolute" };
    }
    const homeDir = resolveOsHomeRelativePath("~");
    const configDir = selector ?? homeDir;
    const settingsDir = selector ?? path.join(homeDir, ".claude");
    const settingsPaths = [
      ...(sources.managedSettingsRoots ?? resolveManagedSettingsRoots()).flatMap((root) =>
        settingsFiles(
          path.join(root, "managed-settings.json"),
          path.join(root, "managed-settings.d"),
        ),
      ),
      path.join(settingsDir, "settings.json"),
      ...(sources.cwd
        ? [
            path.join(sources.cwd, ".claude", "settings.json"),
            path.join(sources.cwd, ".claude", "settings.local.json"),
          ]
        : []),
    ];
    for (const settingsPath of settingsPaths) {
      const reason = inspectSettingsFile(settingsPath);
      if (reason) {
        return { refused: reason };
      }
    }
    let canonicalDir: string;
    try {
      canonicalDir = fs.realpathSync(configDir);
    } catch {
      return { refused: "config-dir-missing" };
    }
    const account = readOauthAccount(canonicalDir);
    return account
      ? { identity: { ...account, configDirSelector: selector ?? null } }
      : { refused: "no-recorded-account" };
  } catch {
    return { refused: "unreadable" };
  }
}

/** Test seam: forget the parsed account file. */
export function resetClaudeNativeAccountIdentityCacheForTest(): void {
  accountCache = undefined;
}
