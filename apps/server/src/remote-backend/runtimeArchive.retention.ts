/**
 * Runtime archive retention (decision 9 and the plan's writers/retention rule): keep the active,
 * the previous rollback runtime, every pending reservation, every pinned version and every
 * version a live process still uses. Pruning reads only the latest durable pointer, so it always
 * follows the commit that made a version unreferenced; nothing is pruned before a first commit.
 *
 * Deletion is crash-safe: an entry is first renamed into `trash/` (atomic, synced), then deleted.
 * A crash leaves either the whole entry under `entries/` or a trash member the next run removes.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { syncServiceDirectory } from "./localSupervisorService.setup.files.ts";
import { isRuntimeArchiveKey, type RuntimeArchiveKey } from "./runtimeArchive.key.ts";
import {
  pruneRuntimeArchivePointers,
  readRuntimeArchivePointer,
  type RuntimeArchivePointer,
} from "./runtimeArchive.pointer.ts";
import { listRuntimeArchiveKeys, type RuntimeArchiveStore } from "./runtimeArchive.store.ts";

export interface RuntimeArchiveRetentionPlan {
  readonly retain: ReadonlyArray<RuntimeArchiveKey>;
  readonly prune: ReadonlyArray<RuntimeArchiveKey>;
}

/** Pure retention decision; `inUse` names versions a running process still executes from. */
export function planRuntimeArchiveRetention(
  pointer: RuntimeArchivePointer,
  present: ReadonlyArray<RuntimeArchiveKey>,
  inUse: ReadonlyArray<RuntimeArchiveKey>,
): RuntimeArchiveRetentionPlan {
  if (!inUse.every(isRuntimeArchiveKey)) throw new Error("In-use runtime archive key is invalid.");
  // No durable commit yet: there is no authority to call anything unreferenced.
  if (pointer.sequence === 0) return Object.freeze({ retain: present, prune: Object.freeze([]) });
  const held = new Set<RuntimeArchiveKey>([...pointer.pending, ...pointer.pinned, ...inUse]);
  if (pointer.active) held.add(pointer.active);
  if (pointer.previous) held.add(pointer.previous);
  return Object.freeze({
    retain: Object.freeze(present.filter((key) => held.has(key))),
    prune: Object.freeze(present.filter((key) => !held.has(key))),
  });
}

async function emptyTrash(store: RuntimeArchiveStore, signal?: AbortSignal) {
  const names = await fs.readdir(store.trash);
  for (const name of names) {
    signal?.throwIfAborted();
    await store.checkpoint();
    await fs.rm(join(store.trash, name), { recursive: true, force: true });
  }
  if (names.length) await syncServiceDirectory(store.trash);
}

/**
 * Prunes unreferenced versions. Idempotent; refuses (without deleting more) if the pointer
 * changes while it runs, so a concurrent commit can never lose a newly referenced version.
 */
export async function pruneRuntimeArchives(
  store: RuntimeArchiveStore,
  options: {
    readonly inUse?: ReadonlyArray<RuntimeArchiveKey>;
    readonly signal?: AbortSignal;
  } = {},
) {
  const { signal } = options;
  await store.checkpoint();
  await emptyTrash(store, signal);
  const pointer = await readRuntimeArchivePointer(store);
  const plan = planRuntimeArchiveRetention(
    pointer,
    await listRuntimeArchiveKeys(store),
    options.inUse ?? [],
  );
  for (const key of plan.prune) {
    signal?.throwIfAborted();
    await store.checkpoint();
    if ((await readRuntimeArchivePointer(store)).sequence !== pointer.sequence)
      throw new Error("Runtime archive pointer changed during retention; retry after it settles.");
    await fs.rename(join(store.entries, key), join(store.trash, `${key}.${randomUUID()}`));
    await syncServiceDirectory(store.entries);
    await syncServiceDirectory(store.trash);
  }
  await emptyTrash(store, signal);
  if (pointer.sequence > 0) await pruneRuntimeArchivePointers(store);
  return Object.freeze({ pointer, retained: plan.retain, pruned: plan.prune });
}
