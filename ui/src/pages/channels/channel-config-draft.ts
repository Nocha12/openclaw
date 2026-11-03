import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  collectBaseArrayPaths,
  formatConfigPatchPath,
} from "../../../../src/config/patch-replace-paths.js";
import type { ConfigSnapshot } from "../../api/types.ts";
import type { ChannelConfigEdit } from "../../lib/channels/index.ts";
import {
  pruneEmptyConfigForm,
  REDACTED_SENTINEL,
  removePathValue,
  setPathValue,
  type JsonSchema,
} from "../../lib/config-form-utils.ts";
import { coerceConfigFormValues } from "../../lib/config/config-draft-model.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { storedSecretSource } from "../../lib/config/stored-secret-source.ts";

/** The form's view of a channel: its saved values with the unsaved edits on top. */
export function applyChannelConfigEdits(
  base: Record<string, unknown> | null,
  channelId: string,
  edits: readonly ChannelConfigEdit[],
): Record<string, unknown> {
  const root: Record<string, unknown> = {
    channels: { [channelId]: structuredClone(base ?? {}) },
  };
  for (const { path, value } of edits) {
    if (value === undefined) {
      removePathValue(root, path);
    } else {
      setPathValue(root, path, structuredClone(value));
    }
  }
  return (root.channels as Record<string, Record<string, unknown>>)[channelId] ?? {};
}

function savedAt(
  base: Record<string, unknown> | null,
  channelId: string,
  path: ReadonlyArray<string | number>,
): unknown {
  let node: unknown = { channels: { [channelId]: base ?? {} } };
  for (const segment of path) {
    node =
      isRecord(node) || Array.isArray(node)
        ? (node as Record<string, unknown>)[segment]
        : undefined;
  }
  return node;
}

/** Emptying a field typed over a stored secret keeps the secret; nothing here deletes it. */
export function emptiesStoredSecret(
  base: Record<string, unknown> | null,
  channelId: string,
  path: ReadonlyArray<string | number>,
  value: unknown,
): boolean {
  return (
    (value === undefined || value === "") && savedAt(base, channelId, path) === REDACTED_SENTINEL
  );
}

/**
 * Whether an edit would land on a stored secret that isn't proven plain text in the file. The
 * field is read-only then, so only a reference that arrived after typing began gets here, and
 * Save leaves it alone.
 */
export function writesOverReference(
  snapshot: ConfigSnapshot | null | undefined,
  path: ReadonlyArray<string | number>,
): boolean {
  let node: unknown = resolveEditableSnapshotConfig(snapshot);
  for (const segment of path) {
    node =
      isRecord(node) || Array.isArray(node)
        ? (node as Record<string, unknown>)[segment]
        : undefined;
  }
  return node === REDACTED_SENTINEL && storedSecretSource(snapshot, path).kind !== "literal";
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * A list or object edited whole keeps each stored secret inside it, as a single field does:
 * emptying one keeps it, and one that isn't proven plain text in the file is never written over.
 * Returns undefined when, after that, the edit changes nothing.
 */
export function keepStoredSecrets(params: {
  base: Record<string, unknown> | null;
  snapshot: ConfigSnapshot | null | undefined;
  channelId: string;
  path: ReadonlyArray<string | number>;
  value: unknown;
}): { value: unknown } | undefined {
  const { base, snapshot, channelId } = params;
  const keep = (path: ReadonlyArray<string | number>, value: unknown): unknown => {
    if (
      emptiesStoredSecret(base, channelId, path, value) ||
      (value !== REDACTED_SENTINEL && writesOverReference(snapshot, path))
    ) {
      return REDACTED_SENTINEL;
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => keep([...path, index], item));
    }
    if (!isRecord(value)) {
      return value;
    }
    const saved = savedAt(base, channelId, path);
    const kept: Record<string, unknown> = {};
    for (const key of new Set([
      ...Object.keys(value),
      ...(isRecord(saved) ? Object.keys(saved) : []),
    ])) {
      const next = keep([...path, key], value[key]);
      if (next !== undefined) {
        kept[key] = next;
      }
    }
    return kept;
  };
  const value = keep(params.path, params.value);
  return sameValue(value, savedAt(base, channelId, params.path)) ? undefined : { value };
}

function diffInto(
  base: Record<string, unknown>,
  target: Record<string, unknown>,
  parentPath: string,
  replacePaths: string[],
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(target)])) {
    const path = formatConfigPatchPath(parentPath, key);
    if (!Object.hasOwn(target, key)) {
      patch[key] = null;
      replacePaths.push(...collectBaseArrayPaths(base[key], path));
      continue;
    }
    const baseValue = base[key];
    const targetValue = target[key];
    if (!Object.hasOwn(base, key)) {
      patch[key] = structuredClone(targetValue);
    } else if (isRecord(baseValue) && isRecord(targetValue)) {
      const child = diffInto(baseValue, targetValue, path, replacePaths);
      if (Object.keys(child).length > 0) {
        patch[key] = child;
      }
    } else if (!sameValue(baseValue, targetValue)) {
      patch[key] = structuredClone(targetValue);
      // The edit is the whole array, including any entries it removed.
      if (Array.isArray(baseValue)) {
        replacePaths.push(path);
      }
    }
  }
  return patch;
}

/** Only what the edits changed goes out, so untouched secrets stay redacted and off the wire. */
export function buildChannelConfigPatch(params: {
  base: Record<string, unknown> | null;
  channelId: string;
  edits: readonly ChannelConfigEdit[];
  schema: unknown;
}): { patch: Record<string, unknown>; replacePaths: string[] } | null {
  const { channelId, edits, schema } = params;
  const base = params.base ?? {};
  const edited = { channels: { [channelId]: applyChannelConfigEdits(base, channelId, edits) } };
  const coerced = isRecord(schema)
    ? (coerceConfigFormValues(edited, schema as JsonSchema) as Record<string, unknown>)
    : edited;
  const original = { channels: { [channelId]: base } };
  const pruned = pruneEmptyConfigForm(coerced, original);
  const target = (pruned.channels as Record<string, Record<string, unknown>> | undefined)?.[
    channelId
  ];
  const replacePaths: string[] = [];
  const changes = diffInto(base, target ?? {}, `channels.${channelId}`, replacePaths);
  if (Object.keys(changes).length === 0) {
    return null;
  }
  return { patch: { channels: { [channelId]: changes } }, replacePaths };
}
