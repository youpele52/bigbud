import { createHash } from "node:crypto";

import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { message } from "./sshOwnerPickerProof.codec.wire.ts";
import type {
  SshOwnerHydrationSnapshot,
  SshOwnerPaneBinding,
} from "./sshOwnerProductionHydration.ts";
import type { SshOwnerRetirementRow } from "../persistence/Layers/SshOwnerRetirement.ts";

/**
 * Restart reconciliation codec (W3.7).
 *
 * The production owner asks for the backend's unresolved retirement mirror and
 * retained direct pane bindings before it acknowledges the handshake. The rows
 * are durable evidence only: the owner verifies them read-only and never
 * mutates storage, signals or spawns from them.
 *
 * @module sshOwnerPickerProof.codec.reconciliation
 */

const MAX_IDENTITY = 1_024;
const MAX_DETAIL = 4_096;
const MAX_ENVELOPE = 256;

class Limit extends Error {}

const bounded = (value: string, maximum: number) => {
  if (Buffer.byteLength(value) > maximum) throw new Limit();
  return value;
};

/** `dev:ino` → the packed u64 the retirement journal records, or undefined. */
export function packRetirementNamespace(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const match = /^(\d{1,10}):(\d{1,20})$/.exec(value);
  if (!match) return undefined;
  const dev = Number(match[1]);
  const ino = Number(match[2]);
  if (!Number.isSafeInteger(dev) || !Number.isSafeInteger(ino)) return undefined;
  // Mirrors `retirement::identity::pack`: (dev << 32) ^ ino. The halves do not
  // overlap, so the XOR equals the sum; reject a value that leaves safe integers.
  if (ino >= 0x1_0000_0000) return undefined;
  const packed = dev * 0x1_0000_0000 + ino;
  return Number.isSafeInteger(packed) ? packed : undefined;
}

const safe = (value: string | null | undefined) => {
  if (value === null || value === undefined || !/^\d{1,16}$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
};

/** One canonical, bounded view of a retirement row, used for both wire and digest. */
function canonicalRetirement(row: SshOwnerRetirementRow) {
  return {
    targetId: bounded(row.targetId, MAX_IDENTITY),
    // The mirror is target-scoped, so every unresolved row is the owner intent.
    kind: "owner",
    state: bounded(row.state, 32),
    ownerEpoch: bounded(row.ownerEpoch, 128),
    pid: row.pid ?? 0,
    start: safe(row.startTime),
    namespace: packRetirementNamespace(row.namespace) ?? null,
    detail: bounded(row.detail, MAX_DETAIL),
  };
}

function canonicalPane(row: SshOwnerPaneBinding) {
  return {
    ownerKey: bounded(row.ownerKey, MAX_DETAIL),
    threadId: bounded(row.threadId ?? "", MAX_DETAIL),
    terminalId: bounded(row.terminalId ?? "", MAX_DETAIL),
    ownerEpoch: bounded(row.ownerEpoch ?? "", 128),
    targetId: bounded(row.targetId ?? "", MAX_IDENTITY),
    generation: bounded(row.generation ?? "", 128),
    leaseId: bounded(row.leaseId ?? "", 128),
    state: bounded(row.state, 32),
    remoteShellPid: row.remoteShellPid ?? null,
    terminated: row.terminated === true,
  };
}

function digestRetirement(row: SshOwnerRetirementRow) {
  const { detail: _detail, ...rest } = canonicalRetirement(row);
  return rest;
}

/**
 * SHA-256 over the reconciliation-relevant fields only. Unrelated columns
 * (`detail`, `updatedAt`) never change it where they cannot change the owner's
 * decision.
 */
export function digestSshOwnerReconciliation(snapshot: SshOwnerHydrationSnapshot): Uint8Array {
  const canonical = {
    retirements: snapshot.retirementMirror
      .map(digestRetirement)
      .toSorted((left, right) => left.targetId.localeCompare(right.targetId)),
    panes: snapshot.paneBindings
      .map(canonicalPane)
      .toSorted((left, right) => left.ownerKey.localeCompare(right.ownerKey)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest();
}

/** Encodes the snapshot the owner asked for, with its exact acknowledgement digest. */
export function encodeReconcileSnapshot(
  requestId: Uint8Array,
  snapshot: SshOwnerHydrationSnapshot,
  error?: "storageUnavailable",
): { readonly payload: Uint8Array; readonly digest: Uint8Array } {
  const retirements = error === undefined ? snapshot.retirementMirror.map(canonicalRetirement) : [];
  const panes = error === undefined ? snapshot.paneBindings.map(canonicalPane) : [];
  if (retirements.length + panes.length > MAX_ENVELOPE) throw new Limit();
  const digest =
    error === undefined
      ? digestSshOwnerReconciliation(snapshot)
      : createHash("sha256").update("unavailable").digest();
  const payload = message(19, (writer) => {
    writer.fieldBytes(1, requestId);
    writer.fieldBytes(2, digest);
    for (const row of retirements) {
      const body = new WireWriter();
      body.fieldString(1, row.targetId);
      body.fieldString(2, row.kind);
      body.fieldString(3, row.state);
      if (row.ownerEpoch) body.fieldString(4, row.ownerEpoch);
      if (row.pid !== 0) body.fieldUint(5, row.pid);
      if (row.start !== 0) body.fieldUint(6, row.start);
      if (row.namespace !== null) body.fieldUint(7, row.namespace);
      if (row.detail) body.fieldString(8, row.detail);
      writer.fieldRepeatedMessage(3, body.finish());
    }
    for (const pane of panes) {
      const body = new WireWriter();
      body.fieldString(1, pane.ownerKey);
      if (pane.threadId) body.fieldString(2, pane.threadId);
      if (pane.terminalId) body.fieldString(3, pane.terminalId);
      if (pane.ownerEpoch) body.fieldString(4, pane.ownerEpoch);
      if (pane.targetId) body.fieldString(5, pane.targetId);
      if (pane.generation) body.fieldString(6, pane.generation);
      if (pane.leaseId) body.fieldString(7, pane.leaseId);
      body.fieldString(8, pane.state);
      if (pane.remoteShellPid != null) body.fieldUint(9, pane.remoteShellPid);
      if (pane.terminated === true) body.fieldUint(10, 1);
      writer.fieldRepeatedMessage(4, body.finish());
    }
    if (error !== undefined) writer.fieldUint(5, 13);
  });
  return { payload, digest };
}
