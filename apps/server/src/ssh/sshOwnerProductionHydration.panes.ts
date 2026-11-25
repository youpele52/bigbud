import type { SshOwnerPaneBinding } from "./sshOwnerProductionHydration.ts";

/**
 * Read-only decoding of a retained direct pane row for restart reconciliation.
 *
 * The table stores one JSON record per pane. Version 1 (legacy direct shell) and
 * version 2 (local terminal host) carry different pane facts, so both are read
 * defensively: a row that cannot be decoded still travels with its durable
 * `owner_key`, reservation id and state, and the owner refuses it as
 * unrecoverable rather than this reader inventing an identity.
 *
 * @module sshOwnerProductionHydration.panes
 */

export interface SshOwnerPaneRow {
  readonly ownerKey: string;
  readonly reservationId: string;
  readonly controllerId: string;
  readonly state: string;
  readonly ownerJson: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

const pid = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 1 ? value : undefined;

function paneIdentity(json: unknown): { threadId: string; terminalId: string } {
  const pane = record(record(json)?.pane);
  return { threadId: text(pane?.threadId), terminalId: text(pane?.terminalId) };
}

function hosted(json: Record<string, unknown>) {
  return {
    threadId: paneIdentity(json).threadId,
    terminalId: paneIdentity(json).terminalId,
    targetId: text(json.executionTargetId),
    ownerEpoch: "",
    remoteShellPid: pid(json.remoteShellPid),
  };
}

function legacy(json: Record<string, unknown>) {
  const intent = record(json.intent);
  const lifecycle = record(intent?.lifecycle);
  return {
    threadId: paneIdentity(json).threadId,
    terminalId: paneIdentity(json).terminalId,
    targetId: text(intent?.executionTargetId),
    // A trusted lifecycle epoch is the only owner-epoch evidence a legacy
    // record can carry; a direct pane from another owner stays unprovable.
    ownerEpoch: text(lifecycle?.epoch),
    remoteShellPid: undefined,
  };
}

/**
 * Decodes one table row. Unknown states and empty identities are preserved so
 * the owner can refuse them; nothing here is treated as termination evidence.
 */
export function decodeSshOwnerPaneRow(row: SshOwnerPaneRow): SshOwnerPaneBinding {
  let json: Record<string, unknown> | undefined;
  try {
    json = record(JSON.parse(row.ownerJson));
  } catch {
    json = undefined;
  }
  const decoded =
    json === undefined
      ? { threadId: "", terminalId: "", targetId: "", ownerEpoch: "", remoteShellPid: undefined }
      : json.version === 2
        ? hosted(json)
        : legacy(json);
  return {
    ownerKey: row.ownerKey,
    threadId: decoded.threadId,
    terminalId: decoded.terminalId,
    ownerEpoch: decoded.ownerEpoch,
    targetId: decoded.targetId,
    generation: "",
    leaseId: row.reservationId,
    state: row.state,
    ...(decoded.remoteShellPid === undefined ? {} : { remoteShellPid: decoded.remoteShellPid }),
    ...(json?.terminationConfirmed === true ? { terminated: true } : {}),
  };
}
