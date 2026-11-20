/**
 * Workspace runtime-mode reservation record (P7 increment 4, WP-4A).
 *
 * One host/account/real path is either a laptop-runtime workspace (a laptop backend runs
 * providers against it over SSH) or a remote-runtime workspace (the backend on that host owns
 * it), never both. Reservations live as files under `~/.bigbud/workspace-modes/<key>/` on the
 * workspace host, one immutable file per generation (`<generation>.json`). A generation is
 * published by an exclusive create, so creating generation `n + 1` is the compare-and-swap:
 * exactly one writer that observed generation `n` can win.
 *
 * @module workspaceMode.record
 */
import { createHash } from "node:crypto";

import { Data } from "effect";

export const WORKSPACE_MODE_FORMAT = "bigbud.workspace-mode.v1";
export const WORKSPACE_MODE_DIRECTORY = "workspace-modes";
export const MAX_WORKSPACE_MODE_RECORD_BYTES = 1024;

export type WorkspaceRuntimeMode = "laptop-runtime" | "remote-runtime";

export interface WorkspaceModeIdentity {
  /** `machine-v1:<sha256>`, the same digest `@bigbud/shared/machineIdentity` produces. */
  readonly hostIdentity: string;
  readonly accountUid: number;
  /** SHA-256 of the real path resolved on the workspace host; never the path itself. */
  readonly realpathSha256: string;
}

export interface WorkspaceModeRecord extends WorkspaceModeIdentity {
  readonly generation: number;
  readonly mode: WorkspaceRuntimeMode;
  /** Backend that established the mode; null after a conversion until that mode's backend claims it. */
  readonly owner: string | null;
}

export type WorkspaceModeInspection =
  | { readonly kind: "unsupported"; readonly reason: string }
  | {
      readonly kind: "ready";
      readonly identity: WorkspaceModeIdentity;
      readonly current: WorkspaceModeRecord | null;
    };

/** Shared by the local filesystem store and the SSH shell store. */
export interface WorkspaceModeStore {
  readonly inspect: (workspaceRoot: string) => Promise<WorkspaceModeInspection>;
  readonly publish: (next: WorkspaceModeRecord) => Promise<"committed" | "conflict">;
}

export class WorkspaceModeConflictError extends Data.TaggedError("WorkspaceModeConflictError")<{
  readonly message: string;
  readonly holder: WorkspaceRuntimeMode;
}> {}

export class WorkspaceModeUnavailableError extends Data.TaggedError(
  "WorkspaceModeUnavailableError",
)<{ readonly message: string }> {}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const HOST_IDENTITY = /^machine-v1:[0-9a-f]{64}$/;
const OWNER = /^backend-v1:[0-9a-f]{64}$/;
const MAX_GENERATION = Number.MAX_SAFE_INTEGER;
const KEYS = [
  "format",
  "generation",
  "hostIdentity",
  "accountUid",
  "realpathSha256",
  "mode",
  "owner",
] as const;

export const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

/** The host-side shell computes the same digest over the same newline-joined fields. */
export const workspaceModeKey = (identity: WorkspaceModeIdentity) =>
  sha256Hex(`${identity.hostIdentity}\n${identity.accountUid}\n${identity.realpathSha256}`);

/** Stable per backend state root, without revealing the path. */
export const workspaceModeOwnerId = (machine: string, stateDir: string) =>
  `backend-v1:${sha256Hex(`bigbud.workspace-mode.owner.v1\0${machine}\0${stateDir}`)}`;

export function isValidWorkspaceModeIdentity(identity: WorkspaceModeIdentity): boolean {
  return (
    HOST_IDENTITY.test(identity.hostIdentity) &&
    Number.isSafeInteger(identity.accountUid) &&
    identity.accountUid >= 0 &&
    SHA256_HEX.test(identity.realpathSha256)
  );
}

/** Canonical bytes: fixed key order and no whitespace, so CAS compares are exact. */
export function encodeWorkspaceModeRecord(record: WorkspaceModeRecord): string {
  if (!isValidWorkspaceModeRecord(record)) throw new Error("Invalid workspace mode record.");
  return JSON.stringify({
    format: WORKSPACE_MODE_FORMAT,
    generation: record.generation,
    hostIdentity: record.hostIdentity,
    accountUid: record.accountUid,
    realpathSha256: record.realpathSha256,
    mode: record.mode,
    owner: record.owner,
  });
}

function isValidWorkspaceModeRecord(record: WorkspaceModeRecord): boolean {
  return (
    isValidWorkspaceModeIdentity(record) &&
    Number.isSafeInteger(record.generation) &&
    record.generation >= 1 &&
    record.generation <= MAX_GENERATION &&
    (record.mode === "laptop-runtime" || record.mode === "remote-runtime") &&
    (record.owner === null || OWNER.test(record.owner))
  );
}

/** Rejects anything that is not byte-identical to its own canonical encoding. */
export function decodeWorkspaceModeRecord(raw: string): WorkspaceModeRecord {
  if (Buffer.byteLength(raw) > MAX_WORKSPACE_MODE_RECORD_BYTES)
    throw new Error("Workspace mode record is too large.");
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Workspace mode record is not an object.");
  const entries = value as Record<string, unknown>;
  if (Object.keys(entries).join() !== KEYS.join() || entries.format !== WORKSPACE_MODE_FORMAT)
    throw new Error("Unknown workspace mode record format.");
  const record = {
    generation: entries.generation,
    hostIdentity: entries.hostIdentity,
    accountUid: entries.accountUid,
    realpathSha256: entries.realpathSha256,
    mode: entries.mode,
    owner: entries.owner,
  } as WorkspaceModeRecord;
  if (!isValidWorkspaceModeRecord(record) || encodeWorkspaceModeRecord(record) !== raw)
    throw new Error("Invalid workspace mode record.");
  return record;
}

export const sameIdentity = (a: WorkspaceModeIdentity, b: WorkspaceModeIdentity) =>
  a.hostIdentity === b.hostIdentity &&
  a.accountUid === b.accountUid &&
  a.realpathSha256 === b.realpathSha256;

export type ReservationDecision =
  | { readonly kind: "held"; readonly record: WorkspaceModeRecord }
  | { readonly kind: "publish"; readonly next: WorkspaceModeRecord }
  | { readonly kind: "conflict"; readonly holder: WorkspaceModeRecord };

/**
 * Same mode is shared (several laptops may already use one SSH folder); an unclaimed mode left
 * by a conversion is claimed by the first backend of that mode; the opposite mode is refused.
 */
export function decideReservation(
  identity: WorkspaceModeIdentity,
  current: WorkspaceModeRecord | null,
  mode: WorkspaceRuntimeMode,
  owner: string,
): ReservationDecision {
  if (current !== null && !sameIdentity(identity, current))
    throw new Error("Workspace mode record does not match its host, account or folder.");
  if (current === null)
    return { kind: "publish", next: { ...identity, generation: 1, mode, owner } };
  if (current.mode !== mode) return { kind: "conflict", holder: current };
  if (current.owner !== null) return { kind: "held", record: current };
  return { kind: "publish", next: { ...current, generation: current.generation + 1, owner } };
}

export function workspaceModeConflictMessage(input: {
  readonly requested: WorkspaceRuntimeMode;
  readonly workspaceRoot: string;
  readonly host: string;
}): string {
  const where = `'${input.workspaceRoot}' on ${input.host}`;
  return input.requested === "laptop-runtime"
    ? `${where} is a remote-runtime workspace: the bigbud backend on that host owns it. Open it from that host's remote backend window instead, or convert it to laptop-runtime from that backend while no turns or terminals run there. Symlinks and other paths to the same folder share this reservation.`
    : `${where} is a laptop-runtime workspace: a laptop bigbud backend runs providers against it over SSH. Open it from that laptop instead, or convert it to remote-runtime from that laptop while no turns or terminals run there. Symlinks and other paths to the same folder share this reservation.`;
}
