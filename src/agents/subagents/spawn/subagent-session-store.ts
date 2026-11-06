import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isInternalSessionEffectsKey } from "../../../config/sessions/internal-session-key.js";
import {
  retainPreparedSessionEntryPredicate,
  type PreparedSessionEntryStaleness,
} from "../../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
  readCapturedSessionActorEntry,
  type CapturedSessionActorStorageOwner,
  type SelectedSessionActorStorageBinding,
} from "../../../config/sessions/session-actor-storage-binding.js";
import { projectSessionEntryCapabilityFacts } from "../../../config/sessions/session-entry-capability-facts.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { SessionRowProjectionBinding } from "../../../gateway/session-row-projection-binding.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { getInProcessGatewayRequestContext } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  isIncognitoSessionKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../../routing/session-key.js";
import { assertAgentSessionWriteAdmission } from "../../../sessions/session-agent-work-admission.js";
import { onSessionIdentityMutation } from "../../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import { AsyncContext } from "../../../shared/async-context.js";
import {
  resolveExplicitIncognitoAgentSqliteTarget,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../../state/openclaw-agent-db.paths.js";

type PersistedSessionCapabilityEntry = Pick<
  SessionEntry,
  | "sessionId"
  | "lifecycleRevision"
  | "createdVia"
  | "spawnDepth"
  | "subagentRole"
  | "subagentControlScope"
  | "spawnedBy"
  | "completionOwnerSessionKey"
  | "inheritedToolPolicyVersion"
  | "inheritedToolPolicySource"
  | "inheritedToolAllow"
  | "inheritedToolDeny"
  | "delegatedToolPolicy"
>;
export type SessionCapabilityEntry = {
  [Key in keyof PersistedSessionCapabilityEntry]?: unknown;
} & { clientCapabilities?: string[] };

/** A complete store view; reads are memoized only for the current synchronous resolution. */
export type SessionCapabilityLookup = {
  /** Cross-agent owner projection: missing rows are authoritative, never a database fallback. */
  authoritative?: true;
  /** Reuse this memo when depth fallback revisits the same logical store. */
  scope?: { storePath: string; agentId: string };
  get: (sessionKey: string) => SessionCapabilityEntry | undefined;
  getById: (sessionId: string) => SessionCapabilityEntry | undefined;
};

export type SessionCapabilityStore =
  | Record<string, SessionCapabilityEntry>
  | SessionCapabilityLookup;

/** Capture the memory namespace while reading its current policy at each effect. */
export function createMemorySessionCapabilityStore(
  memory:
    | CapturedSessionActorStorageOwner
    | SelectedSessionActorStorageBinding
    | undefined = getSessionActorStorageBinding({}),
): SessionCapabilityLookup | undefined {
  if (!memory) {
    return undefined;
  }
  const captured =
    "actor" in memory
      ? captureSessionActorStorageOwner({ sessionActor: memory }, memory.authority)
      : memory;
  if (!captured) {
    return undefined;
  }
  const owners = new Map<string, CapturedSessionActorStorageOwner | undefined>([
    [captured.agentId, captured],
  ]);
  const assertCurrent = () => {
    captured.authority.assertCurrent();
    captured.owner?.assertCurrent();
    captured.binding?.actor.assertReadable();
  };
  return {
    authoritative: true,
    get(sessionKey) {
      assertCurrent();
      const agentId = parseAgentSessionKey(sessionKey)?.agentId;
      if (!agentId || (agentId !== captured.agentId && !isIncognitoSessionKey(sessionKey))) {
        throw new Error("Completion lineage requires its captured session actor owner");
      }
      if (!owners.has(agentId)) {
        owners.set(
          agentId,
          captureSessionActorStorageOwner(
            {
              agentId,
              sessionActor: captured.binding,
              storePath: resolveIncognitoOpenClawAgentSqlitePath({
                agentId,
                env: { OPENCLAW_STATE_DIR: path.resolve(captured.path, "../../../..") },
              }),
            },
            captured.authority,
          ),
        );
      }
      const owner = owners.get(agentId);
      const entry = owner && readCapturedSessionActorEntry(owner, sessionKey);
      return entry && projectSessionEntryCapabilityFacts(entry);
    },
    getById(sessionId) {
      assertCurrent();
      const binding = captured.binding;
      const row = captured.owner
        ? captured.owner.readSessionById(sessionId, captured.authority, { currentOnly: true })
        : binding?.agentId === captured.agentId &&
            path.resolve(binding.path) === path.resolve(captured.path)
          ? binding.actor.storage?.readCurrent(
              {
                type: "session.entry.readById",
                input: { sessionId, projection: "list", currentOnly: true },
              },
              captured.authority,
            )
          : undefined;
      return row && projectSessionEntryCapabilityFacts(row.entry);
    },
  };
}

/** Facts from an owning read in the same synchronous policy resolution. */
export type PreparedSessionCapabilityEntry = {
  sessionKey: string;
  entry: SessionCapabilityEntry;
};

export function isSessionCapabilityLookup(
  store: SessionCapabilityStore | undefined,
): store is SessionCapabilityLookup {
  return typeof store?.get === "function" && typeof store.getById === "function";
}

export function asSessionCapabilityLookup(store: SessionCapabilityStore): SessionCapabilityLookup {
  if (isSessionCapabilityLookup(store)) {
    return store;
  }
  return {
    get: (key) => store[key],
    getById: (id) => {
      const normalizedId = normalizeOptionalString(id);
      return normalizedId
        ? Object.values(store).find(
            (entry) => normalizeOptionalString(entry?.sessionId) === normalizedId,
          )
        : undefined;
    },
  };
}

export type SessionCapabilityRead = { storePath: string; agentId: string } & (
  | { sessionKey: string; sessionId?: never }
  | { sessionId: string; sessionKey?: never }
);

/** Data-only inputs consumed by a prepared requester policy, including absent rows. */
export type SessionCapabilitySnapshot = {
  query: SessionCapabilityRead;
  facts: Array<{ field: keyof PersistedSessionCapabilityEntry; value: unknown }> | undefined;
};

const capabilityFields = [
  "sessionId",
  "lifecycleRevision",
  "createdVia",
  "spawnDepth",
  "subagentRole",
  "subagentControlScope",
  "spawnedBy",
  "completionOwnerSessionKey",
  "inheritedToolPolicyVersion",
  "inheritedToolPolicySource",
  "inheritedToolAllow",
  "inheritedToolDeny",
  "delegatedToolPolicy",
] as const;

function recordCapabilityRead(
  query: SessionCapabilityRead,
  entry: SessionCapabilityEntry | undefined,
) {
  // A released owner has finished collecting its facts.
  const scope = preparedReads.getStore();
  (scope?.isActive() === false ? undefined : scope)?.onRead?.({
    query,
    facts:
      entry && capabilityFields.map((field) => ({ field, value: structuredClone(entry[field]) })),
  });
  return entry;
}

class SessionCapabilityReadRequired extends Error {
  constructor(readonly query: SessionCapabilityRead) {
    super("Session capability metadata requires worker preparation");
  }
}

const log = createSubsystemLogger("agents/session-capability");

export type SessionCapabilityStaleReason =
  | PreparedSessionEntryStaleness
  | "session-id-changed"
  | "row-appeared"
  | "unprepared-read";

/** Retained capability facts no longer certify the policy decided from them. */
export class SessionCapabilityMetadataChangedError extends Error {
  readonly code = "SESSION_CAPABILITY_METADATA_CHANGED";
  constructor(
    readonly target: string,
    readonly reason: SessionCapabilityStaleReason,
    readonly changedFields: readonly string[],
    cause: unknown,
    message = "Session capability metadata changed",
  ) {
    super(message, { cause });
  }
}

/** Names only: capability values can carry tool policy and must not reach logs. */
function diffCapabilityFactFields(
  before: SessionEntry | undefined,
  after: SessionEntry | undefined,
): string[] {
  const previous = before && projectSessionEntryCapabilityFacts(before);
  const next = after && projectSessionEntryCapabilityFacts(after);
  if (!previous || !next) {
    return previous === next ? [] : ["(row)"];
  }
  return (Object.keys(previous) as Array<keyof typeof previous>).filter(
    (field) => JSON.stringify(previous[field]) !== JSON.stringify(next[field]),
  );
}

function capabilityMetadataChanged(
  query: SessionCapabilityRead,
  reason: SessionCapabilityStaleReason,
  changedFields: readonly string[],
  cause: unknown,
  options?: { warn?: boolean; message?: string },
) {
  const target = query.sessionKey ?? "session-id-lookup";
  // Replays re-check per tool step; one line per stale reader is enough to diagnose.
  if (options?.warn !== false) {
    log.warn(
      `session capability metadata changed: target=${target} agent=${query.agentId} reason=${reason}` +
        (changedFields.length > 0 ? ` fields=${changedFields.join(",")}` : ""),
    );
  }
  return new SessionCapabilityMetadataChangedError(
    target,
    reason,
    changedFields,
    cause,
    options?.message,
  );
}

const preparedReads = new AsyncContext<{
  entries: Map<string, () => SessionCapabilityEntry | undefined>;
  retain: boolean;
  onRead?: (snapshot: SessionCapabilitySnapshot) => void;
  /** False once the preparing owner released its readers. */
  isActive: () => boolean;
}>(Symbol("preparedSessionCapabilityReads"));
const legacyReader = new AsyncContext<
  (query: SessionCapabilityRead) => SessionCapabilityEntry | undefined
>(Symbol("legacySessionCapabilityReader"));
const readKey = (query: SessionCapabilityRead) => JSON.stringify(query);

function memoizeFirstRead(
  reader: () => SessionCapabilityEntry | undefined,
): () => SessionCapabilityEntry | undefined {
  let read: { entry: SessionCapabilityEntry | undefined } | undefined;
  return () => (read ??= { entry: reader() }).entry;
}

/** Only deprecated synchronous SDK adapters may install their compatibility reader. */
export function withLegacySessionCapabilityReader<T>(
  reader: (query: SessionCapabilityRead) => SessionCapabilityEntry | undefined,
  read: () => T,
): T {
  return legacyReader.run(reader, read);
}

/** Prepare only the metadata a synchronous capability policy actually consumes. */
export async function withPreparedSessionCapabilityRead<T>(
  read: () => T,
  options?: { retain?: boolean; onRead?: (snapshot: SessionCapabilitySnapshot) => void },
): Promise<T> {
  const prepared = await prepareCapabilityReads(read, options?.retain === true, options?.onRead);
  try {
    return await prepared.value;
  } finally {
    prepared.release();
  }
}

/** Retain worker-prepared policy until its existing writer receipt invalidates the facts. */
export async function prepareSessionCapabilityRead<T>(read: () => T) {
  const prepared = await prepareCapabilityReads(read, true);
  return { read: prepared.read, release: prepared.release };
}

async function prepareCapabilityReads<T>(
  read: () => T,
  retain: boolean,
  onRead?: (snapshot: SessionCapabilitySnapshot) => void,
) {
  // Queued and detached work inherits async frames. A released scope's readers
  // certify nothing, so its successors prepare current facts instead.
  const ambient = preparedReads.getStore();
  const inherited = ambient?.isActive() === false ? undefined : ambient;
  // A retained scope can outlive the scope it started in (queued runs, retry timers),
  // so it takes its own writer-guarded readers instead of borrowing the parent's.
  // An ordinary scope checks a borrowed reader once, then keeps that answer for its
  // own lifetime, which can also outlast the lender's.
  const entries = new Map(
    retain
      ? undefined
      : [...(inherited?.entries ?? [])].map(([key, reader]) => [key, memoizeFirstRead(reader)]),
  );
  const releases: Array<() => void> = [];
  let active = true;
  let replayWarned = false;
  const scope = { entries, retain, onRead: onRead ?? inherited?.onRead, isActive: () => active };
  const release = () => {
    active = false;
    for (const cleanup of releases.splice(0)) {
      cleanup();
    }
  };
  const replay = () => {
    if (!active) {
      throw new Error("Session capability read is no longer active");
    }
    try {
      return preparedReads.run(scope, read);
    } catch (error) {
      if (error instanceof SessionCapabilityReadRequired) {
        const warn = !replayWarned;
        replayWarned = true;
        throw capabilityMetadataChanged(error.query, "unprepared-read", [], error, {
          warn,
          message: "Session capability metadata changed; prepare it again",
        });
      }
      throw error;
    }
  };
  try {
    for (;;) {
      try {
        return { value: preparedReads.run(scope, read), read: replay, release };
      } catch (error) {
        if (!(error instanceof SessionCapabilityReadRequired)) {
          throw error;
        }
        const { withSessionEntriesFromStoreInWorker } =
          await import("../../../config/sessions/session-entry-read-runtime.js");
        const query = error.query;
        let missingCurrent = true;
        if (retain) {
          releases.push(
            sessionChanges.subscribeFacts((change) => {
              if (
                "all" in change ||
                (change.scope !== "automation" &&
                  (!change.agentId || change.agentId === query.agentId))
              ) {
                missingCurrent = false;
              }
            }),
          );
        }
        let capturedIdentity: string | undefined;
        const reader = await withSessionEntriesFromStoreInWorker(
          {
            storePath: query.storePath,
            agentId: query.agentId,
            ...(query.sessionKey !== undefined
              ? {
                  projection: "full" as const,
                  snapshotFields: [],
                  sessionKeys: [query.sessionKey],
                }
              : {
                  projection: "sharing" as const,
                  selection: { kind: "session-id", sessionId: query.sessionId } as const,
                }),
          },
          async ({ result, database }) => {
            const selected = result.entries[0];
            const entry = selected?.entry;
            let warned = false;
            const warnOnce = () => {
              const first = !warned;
              warned = true;
              return { warn: first };
            };
            if (!retain) {
              return () => {
                if (!active) {
                  throw new SessionCapabilityReadRequired(query);
                }
                return entry;
              };
            }
            const databaseIdentity = result.source?.databaseIdentity ?? capturedIdentity;
            if (!databaseIdentity) {
              return () => {
                if (!active) {
                  throw new SessionCapabilityReadRequired(query);
                }
                assertAgentSessionWriteAdmission(database, query.agentId);
                if (!missingCurrent) {
                  throw capabilityMetadataChanged(query, "row-appeared", [], error, warnOnce());
                }
                return undefined;
              };
            }
            let changedFields: string[] = [];
            const predicate = retainPreparedSessionEntryPredicate({
              databaseIdentity: `file:${databaseIdentity}`,
              sessionKey: selected?.sessionKey ?? query.sessionKey ?? "",
              entry,
              matches: (before, after) => {
                const fields = diffCapabilityFactFields(before, after);
                if (fields.length > 0) {
                  changedFields = fields;
                }
                return fields.length === 0;
              },
            });
            releases.push(predicate.release);
            let idCurrent = true;
            if (query.sessionId !== undefined) {
              releases.push(
                onSessionIdentityMutation((change) => {
                  if (
                    change.databaseIdentity === databaseIdentity &&
                    [
                      change.previous.sessionId,
                      change.kind === "delete" ? undefined : change.current.sessionId,
                    ].some((id) => id?.trim() === query.sessionId)
                  ) {
                    idCurrent = false;
                  }
                }),
              );
            }
            return () => {
              if (!active) {
                throw new SessionCapabilityReadRequired(query);
              }
              assertAgentSessionWriteAdmission(database, query.agentId);
              if (!idCurrent) {
                throw capabilityMetadataChanged(
                  query,
                  "session-id-changed",
                  ["sessionId"],
                  error,
                  warnOnce(),
                );
              }
              if (!predicate.isCurrent()) {
                const reason = predicate.describeStaleness() ?? "unknown-outcome";
                throw capabilityMetadataChanged(
                  query,
                  reason,
                  reason === "facts-changed" ? changedFields : [],
                  error,
                  warnOnce(),
                );
              }
              return entry;
            };
          },
          false,
          retain
            ? (_database, identity) => {
                capturedIdentity = identity.key.startsWith("file:")
                  ? identity.key.slice(5)
                  : undefined;
              }
            : undefined,
        );
        entries.set(readKey(query), reader);
      }
    }
  } catch (error) {
    release();
    throw error;
  }
}

/** Read the existing owner projection; standalone policy resolution prepares worker facts first. */
export function createSubagentSessionStore(
  storePath: string,
  agentId: string,
  prepared?: PreparedSessionCapabilityEntry,
): SessionCapabilityLookup {
  const readScope = { storePath, agentId };
  const selected = getSessionActorStorageBinding({});
  const explicit = resolveExplicitIncognitoAgentSqliteTarget(storePath, { agentId });
  const memory = new Map<string, CapturedSessionActorStorageOwner | undefined>();
  const authority = { assertCurrent() {}, authorize() {} };
  const memoryOwner = (requestedAgentId: string) => {
    if (!memory.has(requestedAgentId)) {
      memory.set(
        requestedAgentId,
        captureSessionActorStorageOwner(
          {
            agentId: requestedAgentId,
            sessionActor: selected,
            storePath:
              explicit?.agentId === requestedAgentId
                ? explicit.path
                : selected
                  ? undefined
                  : resolveIncognitoOpenClawAgentSqlitePath({
                      agentId: requestedAgentId,
                      env: explicit?.env,
                    }),
          },
          authority,
        ),
      );
    }
    const captured = memory.get(requestedAgentId);
    captured?.binding?.actor.assertReadable();
    return captured;
  };
  const readActorEntry = (sessionKey: string) => {
    const captured = memoryOwner(resolveAgentIdFromSessionKey(sessionKey));
    const query = {
      type: "session.entry.read" as const,
      input: { sessionKey, projection: "list" as const },
    };
    const entry = captured?.owner
      ? captured.owner.readStorage(sessionKey, query, captured.authority)
      : captured?.binding?.agentId === captured?.agentId
        ? captured?.binding?.actor.storage?.readCurrent(query, captured.authority)
        : undefined;
    return captured
      ? recordCapabilityRead(
          { storePath: captured.path, agentId: captured.agentId, sessionKey },
          entry,
        )
      : entry;
  };
  const readActorEntryById = (sessionId: string) => {
    const captured = memoryOwner(
      isIncognitoSessionKey(sessionId) ? resolveAgentIdFromSessionKey(sessionId) : agentId,
    );
    const matched = captured?.owner
      ? captured.owner.readSessionById(sessionId, captured.authority, { currentOnly: true })
      : captured?.binding?.agentId === captured?.agentId
        ? captured?.binding?.actor.storage?.readCurrent(
            {
              type: "session.entry.readById",
              input: { sessionId, projection: "list", currentOnly: true },
            },
            captured.authority,
          )
        : undefined;
    if (captured) {
      recordCapabilityRead(
        { storePath: captured.path, agentId: captured.agentId, sessionId },
        matched?.entry,
      );
    }
    return matched;
  };
  const entries = new Map<string, SessionCapabilityEntry | undefined>();
  if (prepared && !isInternalSessionEffectsKey(prepared.sessionKey)) {
    entries.set(prepared.sessionKey, prepared.entry);
  }
  const liveScope = (scope: ReturnType<typeof preparedReads.getStore>) =>
    scope?.isActive() === false ? undefined : scope;
  let preparedEntries = liveScope(preparedReads.getStore());
  const readDurable = (query: SessionCapabilityRead) => {
    const preparedScope = liveScope(preparedReads.getStore()) ?? liveScope(preparedEntries);
    preparedEntries = preparedScope;
    const owner = getInProcessGatewayRequestContext()?.sessionRowProjectionOwner;
    const current =
      !preparedScope?.retain && owner instanceof SessionRowProjectionBinding
        ? owner.readCommittedEntry({
            agentId: query.agentId,
            storePath: query.storePath,
            ...(query.sessionKey !== undefined
              ? { key: query.sessionKey }
              : { sessionId: query.sessionId }),
          })
        : undefined;
    if (current) {
      return recordCapabilityRead(query, current.entry);
    }
    const preparedRead = preparedScope?.entries.get(readKey(query));
    if (preparedRead) {
      return recordCapabilityRead(query, preparedRead());
    }
    const legacy = legacyReader.getStore();
    if (legacy) {
      return recordCapabilityRead(query, legacy(query));
    }
    throw new SessionCapabilityReadRequired(query);
  };
  return {
    scope: { storePath, agentId },
    get: (sessionKey) => {
      if (isIncognitoSessionKey(sessionKey)) {
        return readActorEntry(sessionKey);
      }
      if (explicit || isInternalSessionEffectsKey(sessionKey)) {
        return undefined;
      }
      return entries.has(sessionKey)
        ? recordCapabilityRead({ ...readScope, sessionKey }, entries.get(sessionKey))
        : readDurable({ ...readScope, sessionKey });
    },
    getById: (requestedSessionId) => {
      const id = normalizeOptionalString(requestedSessionId);
      if (!id) {
        return undefined;
      }
      const actorEntry = readActorEntryById(id);
      if (actorEntry || explicit || isIncognitoSessionKey(id)) {
        return actorEntry?.entry;
      }
      if (isInternalSessionEffectsKey(id)) {
        return undefined;
      }
      return readDurable({ ...readScope, sessionId: id });
    },
  };
}
