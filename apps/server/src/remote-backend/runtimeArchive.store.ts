/**
 * Runtime archive store (WP-4B): verified backend graph extractions keyed by version and
 * manifest digest, plus the durable active/previous/pending/pinned pointer. Library only; the
 * update operation (WP-4C/4D) owns serialization and must call these under its single-flight
 * lock, passing that lock's assertion as `checkpoint`.
 *
 * Layout under the store root (all directories 0700, files 0600, owned by the account):
 *   pointers/pointer-<sequence>   numbered no-replace pointer files; highest sequence wins
 *   entries/<key>/graph/          the extracted graph; verified in place by the caller
 *   entries/<key>/entry-v1        written last, after verification; marks the entry complete
 *   trash/                        retention renames pruned entries here before deleting them
 *
 * The root must stay outside backend mutable state (backend home, state dir, service config and
 * agent roots); setup refuses a graph inside them, so this store refuses the same overlap.
 */
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { projectVerifiedBackendGraph, type VerifiedBackendGraph } from "./backendGraph.ts";
import {
  assertLocalSupervisorServiceDirectory,
  readLocalSupervisorServiceFile,
} from "./localSupervisorService.files.ts";
import {
  createServiceNamespace,
  publishServiceFile,
  syncServiceDirectory,
} from "./localSupervisorService.setup.files.ts";
import { assertSetupGraphSeparation } from "./localSupervisorService.setup.validation.ts";
import {
  isRuntimeArchiveKey,
  runtimeArchiveKey,
  type RuntimeArchiveKey,
} from "./runtimeArchive.key.ts";
import {
  commitRuntimeArchivePointer,
  readRuntimeArchivePointer,
  type RuntimeArchivePointer,
  type RuntimeArchivePointerStore,
} from "./runtimeArchive.pointer.ts";

export interface RuntimeArchiveStore extends RuntimeArchivePointerStore {
  readonly root: string;
  readonly entries: string;
  readonly trash: string;
}
export interface RuntimeArchiveEntry {
  readonly revision: 1;
  readonly key: RuntimeArchiveKey;
  readonly version: string;
  readonly target: string;
  readonly manifestSha256: string;
  readonly nodeSha256: string;
  readonly entrySha256: string;
  readonly graphRoot: string;
  readonly rootDev: string;
  readonly rootIno: string;
  readonly rootCtimeNs: string;
}
const ENTRY_FILE = "entry-v1";
const ENTRY_MAX_BYTES = 16 * 1024;

/** Suggested root: a sibling of `backend-services/<authority>`, never inside backend home. */
export function runtimeArchiveStoreRoot(home: string, authorityId: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(authorityId) || authorityId.startsWith("."))
    throw new Error("Runtime archive authority id is invalid.");
  return join(home, ".bigbud/backend-runtimes", authorityId);
}

async function ensurePrivateDirectory(path: string) {
  try {
    await fs.mkdir(path, { mode: 0o700 });
    await syncServiceDirectory(join(path, ".."));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  }
  await assertLocalSupervisorServiceDirectory(path);
}

/** Opens (creating on first use) a private store whose root is separate from mutable state. */
export async function openRuntimeArchiveStore(input: {
  readonly root: string;
  readonly mutableRoots: ReadonlyArray<string>;
  readonly checkpoint?: () => Promise<void>;
}): Promise<RuntimeArchiveStore> {
  const checkpoint = input.checkpoint ?? (async () => {});
  if (input.mutableRoots.length === 0)
    throw new Error("Runtime archive store needs the backend mutable roots to stay separate.");
  assertSetupGraphSeparation(input.root, input.mutableRoots);
  try {
    await assertLocalSupervisorServiceDirectory(input.root);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    await createServiceNamespace(input.root, checkpoint);
  }
  const store = Object.freeze({
    root: input.root,
    pointers: join(input.root, "pointers"),
    entries: join(input.root, "entries"),
    trash: join(input.root, "trash"),
    checkpoint,
  });
  for (const path of [store.pointers, store.entries, store.trash]) {
    await checkpoint();
    await ensurePrivateDirectory(path);
  }
  return store;
}

const referenced = (pointer: RuntimeArchivePointer, key: RuntimeArchiveKey) =>
  pointer.active === key ||
  pointer.previous === key ||
  pointer.pending.includes(key) ||
  pointer.pinned.includes(key);

/**
 * Durably marks `key` pending before its directory exists, so a crash at any later step can
 * never leave an unreferenced copy that retention would treat as prunable. Idempotent.
 */
export async function reserveRuntimeArchive(store: RuntimeArchiveStore, key: RuntimeArchiveKey) {
  if (!isRuntimeArchiveKey(key)) throw new Error("Runtime archive key is invalid.");
  await commitRuntimeArchivePointer(store, (current) => ({
    ...current,
    pending: current.pending.includes(key) ? current.pending : [...current.pending, key],
  }));
  const entryRoot = join(store.entries, key);
  await store.checkpoint();
  await ensurePrivateDirectory(entryRoot);
  return Object.freeze({ key, entryRoot, graphRoot: join(entryRoot, "graph") });
}

function encodeEntry(entry: RuntimeArchiveEntry): string {
  return `${JSON.stringify(entry)}\n`;
}
function decodeEntry(raw: string, key: RuntimeArchiveKey): RuntimeArchiveEntry {
  const value = JSON.parse(raw) as Record<string, unknown>;
  const fields = [
    "revision",
    "key",
    "version",
    "target",
    "manifestSha256",
    "nodeSha256",
    "entrySha256",
    "graphRoot",
    "rootDev",
    "rootIno",
    "rootCtimeNs",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field)) ||
    value.revision !== 1 ||
    value.key !== key ||
    fields.slice(2).some((field) => typeof value[field] !== "string") ||
    runtimeArchiveKey(value.version as string, value.manifestSha256 as string) !== key
  )
    throw new Error("Runtime archive entry record is invalid.");
  return Object.freeze(value) as unknown as RuntimeArchiveEntry;
}

/** The complete entry, or null while it is still reserved/staging (no record yet). */
export async function readRuntimeArchiveEntry(
  store: RuntimeArchiveStore,
  key: RuntimeArchiveKey,
): Promise<RuntimeArchiveEntry | null> {
  try {
    return decodeEntry(
      await readLocalSupervisorServiceFile(join(store.entries, key, ENTRY_FILE), ENTRY_MAX_BYTES),
      key,
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

/** Every entry directory; an unknown member refuses rather than being treated as prunable. */
export async function listRuntimeArchiveKeys(store: RuntimeArchiveStore) {
  const names = await fs.readdir(store.entries);
  if (!names.every(isRuntimeArchiveKey))
    throw new Error("Runtime archive entries contain an unknown member; preserve it.");
  return Object.freeze(names.toSorted());
}

/**
 * Records a graph the caller extracted into the reserved slot and verified there with the
 * existing graph verifier. The original verification token is revalidated, never trusted data.
 */
export async function recordRuntimeArchive(
  store: RuntimeArchiveStore,
  token: VerifiedBackendGraph,
  signal?: AbortSignal,
): Promise<RuntimeArchiveEntry> {
  const graph = await projectVerifiedBackendGraph(token, signal);
  const key = runtimeArchiveKey(graph.version, graph.manifestDigest);
  const entryRoot = join(store.entries, key);
  if (graph.root !== join(entryRoot, "graph"))
    throw new Error("Verified graph is not extracted in its reserved runtime archive slot.");
  if (!referenced(await readRuntimeArchivePointer(store), key))
    throw new Error("Runtime archive must be reserved before it is recorded.");
  const entry: RuntimeArchiveEntry = Object.freeze({
    revision: 1,
    key,
    version: graph.version,
    target: graph.target,
    manifestSha256: graph.manifestDigest,
    nodeSha256: graph.nodeSha256,
    entrySha256: graph.entrySha256,
    graphRoot: graph.root,
    rootDev: graph.rootIdentity.dev,
    rootIno: graph.rootIdentity.ino,
    rootCtimeNs: graph.rootIdentity.ctimeNs,
  });
  const existing = await readRuntimeArchiveEntry(store, key);
  if (existing) {
    if (encodeEntry(existing) !== encodeEntry(entry))
      throw new Error("Runtime archive entry already records a different graph; preserve it.");
    return existing;
  }
  signal?.throwIfAborted();
  await publishServiceFile(join(entryRoot, ENTRY_FILE), encodeEntry(entry), store.checkpoint);
  return entry;
}

/** Durable commit of a new active runtime; the old active becomes the rollback `previous`. */
export async function activateRuntimeArchive(store: RuntimeArchiveStore, key: RuntimeArchiveKey) {
  if (!(await readRuntimeArchiveEntry(store, key)))
    throw new Error("Only a complete recorded runtime archive can become active.");
  return commitRuntimeArchivePointer(store, (current) => ({
    ...current,
    active: key,
    previous: current.active === key ? current.previous : current.active,
    pending: current.pending.filter((pending) => pending !== key),
  }));
}

/** Drops a pending reservation (failed or abandoned staging), making it prunable. */
export function releaseRuntimeArchive(store: RuntimeArchiveStore, key: RuntimeArchiveKey) {
  return commitRuntimeArchivePointer(store, (current) => ({
    ...current,
    pending: current.pending.filter((pending) => pending !== key),
  }));
}

export function pinRuntimeArchive(store: RuntimeArchiveStore, key: RuntimeArchiveKey, pin = true) {
  return commitRuntimeArchivePointer(store, (current) => ({
    ...current,
    pinned: pin
      ? current.pinned.includes(key)
        ? current.pinned
        : [...current.pinned, key]
      : current.pinned.filter((pinned) => pinned !== key),
  }));
}
