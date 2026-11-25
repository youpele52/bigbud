import { randomUUID } from "node:crypto";

import type { RemoteAgentConnectionPool } from "../remote-agent/remoteAgentConnectionPool.ts";
import type { RemoteAgentRuntimeBinding } from "../remote-agent/remoteAgentConnectionPool.ts";
import type { RemoteAgentConnection } from "../remote-agent/remoteAgentConnection.ts";
import {
  TERMINAL_HOST_MAX_PANES,
  TERMINAL_HOST_RETIREMENT_CAPABILITY,
  type TerminalHostInventoryResponse,
  type TerminalHostPane,
  type TerminalHostRetireSshSpawnResponse,
} from "../remote-agent/remoteAgentProtocol.terminalHost.ts";
import { LOCAL_TERMINAL_HOST_TARGET_ID } from "./localTerminalHost.paths.ts";

/**
 * Build A X2 retirement client. The capability is the only proof that the host
 * implements the verbs: an older host yields `unsupported`, and B must then
 * require host exit instead of guessing from panes or liveness.
 *
 * @module localTerminalHost.retirement
 */

/** The manager's owner key is `JSON.stringify([threadId, terminalId])`; other shapes stay empty. */
export function paneIdentityForOwnerKey(
  ownerKey: string | undefined,
  kind: "local" | "managed-ssh",
):
  | { readonly threadId: string; readonly paneId: string; readonly kind: "local" | "managed-ssh" }
  | undefined {
  if (!ownerKey) return undefined;
  try {
    const parsed: unknown = JSON.parse(ownerKey);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((value) => typeof value === "string" && value.length > 0 && value.length <= 256)
    )
      return { threadId: parsed[0] as string, paneId: parsed[1] as string, kind };
  } catch {
    // A hashed/settled owner key carries no application identity; inventory stays bounded.
  }
  return undefined;
}

export class TerminalHostRetirementUnsupportedError extends Error {
  readonly code = "terminalHostRetirementUnsupported";
}

export class TerminalHostRetirementError extends Error {
  constructor(
    readonly code:
      | "terminalHostVerbRefused"
      | "terminalHostInventoryInvalid"
      | "terminalHostLeaseMismatch",
    message: string,
  ) {
    super(message);
  }
}

const bounded = (value: string) => value.length <= 256 && /^[\x20-\x7e]*$/.test(value);

const fail = (code: TerminalHostRetirementError["code"], message: string): never => {
  throw new TerminalHostRetirementError(code, message);
};

function validatePane(pane: TerminalHostPane): void {
  if (
    !bounded(pane.ptyId) ||
    !bounded(pane.threadId) ||
    !bounded(pane.paneId) ||
    !bounded(pane.leaseId) ||
    !bounded(pane.ownerArtifactId) ||
    pane.leaseId !== pane.ptyId ||
    (pane.kind !== "local" && pane.kind !== "managed-ssh")
  )
    fail("terminalHostInventoryInvalid", "The terminal host returned an invalid pane.");
}

async function retirementConnection(
  pool: Pick<RemoteAgentConnectionPool, "getBound">,
  binding: RemoteAgentRuntimeBinding,
  signal: AbortSignal,
): Promise<RemoteAgentConnection> {
  const connection = await pool.getBound(LOCAL_TERMINAL_HOST_TARGET_ID, binding, [
    TERMINAL_HOST_RETIREMENT_CAPABILITY,
  ]);
  if (!connection.supportsCapability(TERMINAL_HOST_RETIREMENT_CAPABILITY))
    throw new TerminalHostRetirementUnsupportedError(
      "This terminal host predates SSH-spawn retirement; B must require host exit.",
    );
  signal.throwIfAborted();
  return connection;
}

export async function inventoryLocalTerminalHost(input: {
  readonly pool: Pick<RemoteAgentConnectionPool, "getBound">;
  readonly binding: RemoteAgentRuntimeBinding;
  readonly maxPanes?: number;
  readonly signal?: AbortSignal;
}): Promise<TerminalHostInventoryResponse> {
  const maxPanes = input.maxPanes ?? TERMINAL_HOST_MAX_PANES;
  if (!Number.isInteger(maxPanes) || maxPanes < 1 || maxPanes > TERMINAL_HOST_MAX_PANES)
    fail("terminalHostInventoryInvalid", "The inventory bound must be 1..64 panes.");
  const signal = input.signal ?? AbortSignal.timeout(10_000);
  const connection = await retirementConnection(input.pool, input.binding, signal);
  const requestId = randomUUID();
  let response: Awaited<ReturnType<RemoteAgentConnection["request"]>>;
  try {
    response = await connection.request(
      {
        type: "terminalHostInventoryRequest",
        value: { requestId, expectedEpoch: input.binding.expectedEpoch, maxPanes },
      },
      (frame) =>
        frame.type === "terminalHostInventoryResponse" && frame.value.requestId === requestId,
      signal,
    );
  } catch (cause) {
    throw new TerminalHostRetirementError(
      "terminalHostVerbRefused",
      `The terminal host did not answer inventory: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (response.type !== "terminalHostInventoryResponse")
    fail("terminalHostVerbRefused", "The terminal host returned another frame.");
  const value = response.value as TerminalHostInventoryResponse;
  if (!value.accepted)
    throw new TerminalHostRetirementError(
      "terminalHostVerbRefused",
      `Terminal host inventory was refused: ${value.errorCode.slice(0, 100)}`,
    );
  if (value.agentEpoch !== input.binding.expectedEpoch)
    fail("terminalHostInventoryInvalid", "The inventory belongs to another host epoch.");
  if (value.panes.length > maxPanes || value.panes.length > TERMINAL_HOST_MAX_PANES)
    fail("terminalHostInventoryInvalid", "The terminal host returned too many panes.");
  for (const pane of value.panes) validatePane(pane);
  if (value.truncated && value.panes.length !== maxPanes)
    fail("terminalHostInventoryInvalid", "The terminal host truncated an invalid page.");
  return value;
}

export async function retireLocalTerminalHostSshSpawn(input: {
  readonly pool: Pick<RemoteAgentConnectionPool, "getBound">;
  readonly binding: RemoteAgentRuntimeBinding;
  readonly leaseIds: ReadonlyArray<string>;
  readonly signal?: AbortSignal;
}): Promise<TerminalHostRetireSshSpawnResponse> {
  const leaseIds = [...new Set(input.leaseIds)];
  if (
    leaseIds.length === 0 ||
    leaseIds.length > TERMINAL_HOST_MAX_PANES ||
    leaseIds.length !== input.leaseIds.length ||
    leaseIds.some((lease) => !bounded(lease))
  )
    fail("terminalHostLeaseMismatch", "Only unique bounded lease identities may be retired.");
  const signal = input.signal ?? AbortSignal.timeout(10_000);
  const connection = await retirementConnection(input.pool, input.binding, signal);
  const requestId = randomUUID();
  let response: Awaited<ReturnType<RemoteAgentConnection["request"]>>;
  try {
    response = await connection.request(
      {
        type: "terminalHostRetireSshSpawnRequest",
        value: {
          requestId,
          expectedEpoch: input.binding.expectedEpoch,
          expectedBuildDigest: input.binding.runtime.buildDigest,
          leaseIds,
        },
      },
      (frame) =>
        frame.type === "terminalHostRetireSshSpawnResponse" && frame.value.requestId === requestId,
      signal,
    );
  } catch (cause) {
    throw new TerminalHostRetirementError(
      "terminalHostVerbRefused",
      `The terminal host did not answer retirement: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (response.type !== "terminalHostRetireSshSpawnResponse")
    fail("terminalHostVerbRefused", "The terminal host returned another frame.");
  const value = response.value as TerminalHostRetireSshSpawnResponse;
  if (!value.accepted)
    throw new TerminalHostRetirementError(
      "terminalHostVerbRefused",
      `SSH spawn retirement was refused: ${value.errorCode.slice(0, 100)}`,
    );
  if (
    value.agentEpoch !== input.binding.expectedEpoch ||
    !value.sshSpawnRetired ||
    value.retiredLeaseIds.length !== leaseIds.length ||
    [...value.retiredLeaseIds].toSorted().join("\0") !== [...leaseIds].toSorted().join("\0")
  )
    fail("terminalHostLeaseMismatch", "The retirement acknowledgement did not match the request.");
  return value;
}
