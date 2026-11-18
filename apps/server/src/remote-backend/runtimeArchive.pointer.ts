/**
 * Durable runtime-archive pointer. Each commit publishes a new numbered pointer file with the
 * existing no-replace private publication, so a crash leaves either the old or the new complete
 * pointer and two racing writers cannot both win the same sequence. The highest sequence wins.
 */
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { readLocalSupervisorServiceFile } from "./localSupervisorService.files.ts";
import { publishServiceFile } from "./localSupervisorService.setup.files.ts";
import { isRuntimeArchiveKey, type RuntimeArchiveKey } from "./runtimeArchive.key.ts";

export const RUNTIME_ARCHIVE_MAX_PENDING = 8;
export const RUNTIME_ARCHIVE_MAX_PINNED = 16;
const POINTER_NAME = /^pointer-(\d{12})$/;
const POINTER_MAX_BYTES = 64 * 1024;

export interface RuntimeArchivePointer {
  readonly revision: 1;
  /** 0 means nothing was ever committed; retention then prunes nothing. */
  readonly sequence: number;
  readonly active: RuntimeArchiveKey | null;
  /** The rollback runtime (decision 9): the active one before the latest activation. */
  readonly previous: RuntimeArchiveKey | null;
  /** Reserved or staged versions an update operation still owns. */
  readonly pending: ReadonlyArray<RuntimeArchiveKey>;
  /** Explicitly held versions; retention never prunes them. */
  readonly pinned: ReadonlyArray<RuntimeArchiveKey>;
}
export type RuntimeArchivePointerChange = Omit<RuntimeArchivePointer, "revision" | "sequence">;
export interface RuntimeArchivePointerStore {
  readonly pointers: string;
  /** Caller authority/lock check, run before each publication step (setup checkpoint shape). */
  readonly checkpoint: () => Promise<void>;
}

export const emptyRuntimeArchivePointer: RuntimeArchivePointer = Object.freeze({
  revision: 1,
  sequence: 0,
  active: null,
  previous: null,
  pending: Object.freeze([]),
  pinned: Object.freeze([]),
});

function keyList(value: unknown, max: number): ReadonlyArray<RuntimeArchiveKey> {
  if (!Array.isArray(value) || value.length > max || !value.every(isRuntimeArchiveKey))
    throw new Error("Runtime archive pointer list is invalid or oversized.");
  const sorted = [...new Set(value)].toSorted();
  if (sorted.length !== value.length) throw new Error("Runtime archive pointer list repeats.");
  return Object.freeze(sorted);
}
function nullableKey(value: unknown): RuntimeArchiveKey | null {
  if (value === null) return null;
  if (!isRuntimeArchiveKey(value)) throw new Error("Runtime archive pointer key is invalid.");
  return value;
}
function normalize(sequence: number, change: RuntimeArchivePointerChange): RuntimeArchivePointer {
  return Object.freeze({
    revision: 1,
    sequence,
    active: nullableKey(change.active),
    previous: nullableKey(change.previous),
    pending: keyList(change.pending, RUNTIME_ARCHIVE_MAX_PENDING),
    pinned: keyList(change.pinned, RUNTIME_ARCHIVE_MAX_PINNED),
  });
}
export function decodeRuntimeArchivePointer(raw: string, sequence: number): RuntimeArchivePointer {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Runtime archive pointer must be an object.");
  const record = value as Record<string, unknown>;
  const keys = ["revision", "sequence", "active", "previous", "pending", "pinned"];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key)))
    throw new Error("Runtime archive pointer has missing or unknown fields.");
  if (record.revision !== 1 || record.sequence !== sequence)
    throw new Error("Runtime archive pointer revision or sequence does not match its name.");
  return normalize(sequence, record as unknown as RuntimeArchivePointerChange);
}
const pointerName = (sequence: number) => `pointer-${String(sequence).padStart(12, "0")}`;

/** Sequences of every published pointer file, ascending. Unknown names are refused. */
export async function listRuntimeArchivePointerSequences(store: RuntimeArchivePointerStore) {
  const sequences: number[] = [];
  for (const name of await fs.readdir(store.pointers)) {
    if (name.startsWith(".setup-") && name.endsWith(".tmp")) continue;
    const match = POINTER_NAME.exec(name);
    if (!match) throw new Error("Runtime archive pointer directory has an unknown member.");
    sequences.push(Number(match[1]));
  }
  return sequences.toSorted((a, b) => a - b);
}

/** The latest durable pointer, or the empty pointer when nothing was committed yet. */
export async function readRuntimeArchivePointer(
  store: RuntimeArchivePointerStore,
): Promise<RuntimeArchivePointer> {
  const sequence = (await listRuntimeArchivePointerSequences(store)).at(-1);
  if (sequence === undefined) return emptyRuntimeArchivePointer;
  const raw = await readLocalSupervisorServiceFile(
    join(store.pointers, pointerName(sequence)),
    POINTER_MAX_BYTES,
  );
  return decodeRuntimeArchivePointer(raw, sequence);
}

function samePointer(a: RuntimeArchivePointerChange, b: RuntimeArchivePointerChange) {
  return (
    a.active === b.active &&
    a.previous === b.previous &&
    a.pending.join("\n") === b.pending.join("\n") &&
    a.pinned.join("\n") === b.pinned.join("\n")
  );
}

/**
 * Compare-and-publish: `change` derives the next state from the latest durable pointer. An
 * unchanged state writes nothing (idempotent). A concurrent writer that published the same
 * sequence first makes this commit fail rather than overwrite it.
 */
export async function commitRuntimeArchivePointer(
  store: RuntimeArchivePointerStore,
  change: (current: RuntimeArchivePointer) => RuntimeArchivePointerChange,
): Promise<RuntimeArchivePointer> {
  await store.checkpoint();
  const current = await readRuntimeArchivePointer(store);
  const next = normalize(current.sequence + 1, change(current));
  if (next.active !== null && next.active === next.previous)
    throw new Error("Runtime archive pointer cannot name one version as active and previous.");
  if (current.sequence > 0 && samePointer(current, next)) return current;
  const { revision, sequence, active, previous, pending, pinned } = next;
  const raw = `${JSON.stringify({ revision, sequence, active, previous, pending, pinned })}\n`;
  await publishServiceFile(join(store.pointers, pointerName(sequence)), raw, store.checkpoint);
  return next;
}

/** Removes superseded pointer files, keeping the latest `keep`. Only retention calls this. */
export async function pruneRuntimeArchivePointers(store: RuntimeArchivePointerStore, keep = 2) {
  const sequences = await listRuntimeArchivePointerSequences(store);
  for (const sequence of sequences.slice(0, Math.max(0, sequences.length - keep))) {
    await store.checkpoint();
    await fs.rm(join(store.pointers, pointerName(sequence)), { force: true });
  }
}
