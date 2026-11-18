import { randomUUID } from "node:crypto";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentOwner, RemoteAgentInputResolution } from "./remoteAgentOwners.ts";
import { RemoteAgentPtyError } from "./remoteAgentPtyClient.types.ts";
import type { RemoteAgentPtyInputReconcileResponse } from "./remoteAgentProtocol.pty.ts";

export const REMOTE_PTY_INPUT_RECONCILE = "terminal.pty-input-reconcile";

function receipt(
  owner: RemoteAgentOwner,
  value: RemoteAgentPtyInputReconcileResponse,
): RemoteAgentInputResolution | undefined {
  const pending = owner.pendingInput;
  if (
    !pending ||
    value.agentEpoch !== owner.epoch ||
    value.ptyId !== owner.resourceId ||
    Buffer.from(value.createDigest).toString("hex") !== owner.digest ||
    value.sequence !== pending.sequence ||
    value.byteLength !== pending.byteLength ||
    Buffer.from(value.payloadDigest).toString("hex") !== pending.sha256
  )
    throw new RemoteAgentPtyError(
      "PTY_INPUT_IDENTITY_CONFLICT",
      "Remote input receipt identity did not match.",
    );
  if (!value.accepted)
    throw new RemoteAgentPtyError(
      "PTY_INPUT_OUTCOME_UNKNOWN",
      "Remote input receipt is unavailable; input remains unconfirmed.",
    );
  if (
    !Number.isSafeInteger(value.bytesWritten) ||
    value.bytesWritten < 0 ||
    value.bytesWritten > pending.byteLength
  )
    throw new RemoteAgentPtyError(
      "PTY_INPUT_OUTCOME_UNKNOWN",
      "Remote input receipt byte count is invalid.",
    );
  switch (value.outcome) {
    case "written":
      if (value.bytesWritten !== pending.byteLength) break;
      return { ...pending, outcome: "written", writerUsable: value.writerUsable };
    case "failed-before-write":
    case "not-admitted":
      if (value.bytesWritten !== 0) break;
      return { ...pending, outcome: value.outcome, writerUsable: value.writerUsable };
    case "accepted":
      if (value.bytesWritten !== 0) break;
      return;
    case "writing":
      return;
  }
  throw new RemoteAgentPtyError(
    "PTY_INPUT_OUTCOME_UNKNOWN",
    "Remote input delivery remains ambiguous; it was not replayed.",
  );
}

function delay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 500);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Bounded receipt observation/atomic no-byte retirement. Never contains input bytes. */
export async function reconcileRemotePtyInput(
  connection: RemoteAgentConnection,
  owner: RemoteAgentOwner,
  cancellation: AbortSignal,
): Promise<RemoteAgentInputResolution> {
  if (!connection.supportsCapability(REMOTE_PTY_INPUT_RECONCILE) || !owner.pendingInput)
    throw new RemoteAgentPtyError(
      "PTY_INPUT_OUTCOME_UNKNOWN",
      "Remote input has no compatible receipt identity; it remains unconfirmed.",
    );
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(15_000)]);
  const pending = owner.pendingInput;
  for (let attempt = 0; attempt < 16; attempt++) {
    signal.throwIfAborted();
    const requestId = randomUUID();
    const response = await connection.request(
      {
        type: "ptyInputReconcileRequest",
        value: {
          requestId,
          expectedEpoch: owner.epoch,
          ptyId: owner.resourceId,
          createDigest: Buffer.from(owner.digest, "hex"),
          sequence: pending.sequence,
          payloadDigest: Buffer.from(pending.sha256, "hex"),
          byteLength: pending.byteLength,
        },
      },
      (frame) =>
        frame.type === "ptyInputReconcileResponse" &&
        frame.value.requestId === requestId &&
        frame.value.ptyId === owner.resourceId,
      signal,
    );
    if (response.type !== "ptyInputReconcileResponse" || response.value.requestId !== requestId)
      throw new RemoteAgentPtyError(
        "PTY_INPUT_OUTCOME_UNKNOWN",
        "Remote input receipt response did not match.",
      );
    const resolved = receipt(owner, response.value);
    if (resolved) return resolved;
    if (attempt < 15) await delay(signal);
  }
  throw new RemoteAgentPtyError(
    "PTY_INPUT_OUTCOME_UNKNOWN",
    "Remote input is still pending; it was not replayed.",
  );
}
