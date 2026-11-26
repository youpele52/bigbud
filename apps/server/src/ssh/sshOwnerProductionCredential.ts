import { randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";

import type { PickerProofBoundTarget } from "./sshOwnerPickerProof.client.session.types.ts";
import type { CredentialState } from "./sshOwnerPickerProof.codec.credential.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";
import {
  buildSshPasswordRequiredMessage,
  SshTargetAuthRequiredError,
} from "./sshTargetUnavailable.ts";

/**
 * In-app SSH password and key-passphrase entry through the production owner
 * (v1.credential.proto). The secret goes from the WebSocket request straight to the owner's
 * per-lease private socket: it is never an owner operand, never logged, never placed on any
 * process's argv or environment, and its buffer is zeroed after the write. The owner feeds it
 * once to its own `ssh` through its askpass helper and caches nothing.
 *
 * @module sshOwnerProductionCredential
 */
export type InAppCredential = "password" | "keyPassphrase";

const MAX_SECRET_BYTES = 511;
const WRITE_TIMEOUT_MS = 5_000;

export { buildSshKeyPassphraseRequiredMessage } from "./sshOwnerProductionCredential.prompt.ts";
import { buildSshKeyPassphraseRequiredMessage } from "./sshOwnerProductionCredential.prompt.ts";

/** The typed prompt error for a target whose owner answered `credentialRequired`. */
export async function credentialRequiredError(
  target: Pick<PickerProofBoundTarget, "targetId" | "inspectCredential">,
  executionTargetId: string,
): Promise<SshTargetAuthRequiredError | undefined> {
  const state = await target.inspectCredential().catch(() => undefined);
  if (state?.credential === "password")
    return new SshTargetAuthRequiredError(
      executionTargetId,
      "password",
      buildSshPasswordRequiredMessage(executionTargetId),
    );
  if (state?.credential === "keyPassphrase" && state.identity)
    return new SshTargetAuthRequiredError(
      executionTargetId,
      "ssh-key-passphrase",
      buildSshKeyPassphraseRequiredMessage(state.identity),
    );
  return undefined;
}

/**
 * Writes the secret and half-closes. The owner accepts the queued connection only at commit,
 * so the socket stays open (a connection closed before `accept` may be dropped) until the
 * caller destroys it after the commit settles.
 */
function writeSecret(socketPath: string, secret: Buffer): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => socket.destroy(new Error("timeout")), WRITE_TIMEOUT_MS);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () =>
      socket.end(secret, () => {
        clearTimeout(timer);
        resolve(socket);
      }),
    );
  });
}

/**
 * Unlocks the target's credential master with `secret`. The secret buffer is zeroed on every
 * path, including refusals before the owner is reached.
 */
export async function unlockProductionCredential(
  target: Pick<
    PickerProofBoundTarget,
    "inspectCredential" | "openCredentialUnlock" | "commitCredentialUnlock"
  >,
  credential: InAppCredential,
  secret: Buffer,
): Promise<CredentialState> {
  try {
    if (
      secret.length === 0 ||
      secret.length > MAX_SECRET_BYTES ||
      secret.some((byte) => byte === 0 || byte === 10 || byte === 13)
    )
      throw new PickerProofOwnerError("invalidOperands");
    const state = await target.inspectCredential();
    if (state.unlocked) return state;
    if (state.credential !== credential) throw new PickerProofOwnerError("operationDenied");
    const lease = randomBytes(32);
    const { socketPath } = await target.openCredentialUnlock(lease, credential);
    const channel = await writeSecret(socketPath, secret);
    try {
      return await target.commitCredentialUnlock(lease);
    } finally {
      channel.destroy();
    }
  } finally {
    secret.fill(0);
  }
}
