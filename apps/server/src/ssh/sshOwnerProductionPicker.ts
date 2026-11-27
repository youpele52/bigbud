import { randomBytes } from "node:crypto";

import type {
  ServerListRemoteFoldersInput,
  ServerListRemoteFoldersResult,
} from "@bigbud/contracts/server/server.remoteFolders";
import type {
  ServerTrustSshHostInput,
  ServerTrustSshHostResult,
} from "@bigbud/contracts/server/server.sshHostTrust";

import { invalidChallenge, ownerFailure } from "./sshOwnerOperation.errors.ts";
import type { PickerProofBoundTarget } from "./sshOwnerPickerProof.client.session.types.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";
import {
  readSshOwnerProductionOwner,
  type SshOwnerProductionRegistration,
} from "./sshOwnerProductionRegistry.ts";
import { descriptorServesTarget } from "./sshOwnerProductionTargets.ts";
import {
  credentialRequiredError,
  type InAppCredential,
  unlockProductionCredential,
} from "./sshOwnerProductionCredential.ts";
import { RemoteTargetDisconnectedError } from "./sshTargetDisconnects.ts";
import {
  buildSshHostTrustRequiredMessage,
  SshTargetAuthRequiredError,
} from "./sshTargetUnavailable.ts";

/**
 * Production remote-project picker over the live Rust owner (cutover rows 9,
 * 12, 17 and 51). Every call binds the exact target through the owner's own
 * descriptor resolution; the owner dials, authenticates and checks host keys.
 * Without a live owner the call is refused typed and nothing is launched.
 *
 * @module sshOwnerProductionPicker
 */

type ProductionRead = () => SshOwnerProductionRegistration | undefined;

interface PendingChallenge {
  readonly targetId: string;
  readonly ownerToken: Uint8Array;
}

/** Challenges the UI may approve; each is single-use and bound to one target. */
const challenges = new Map<string, PendingChallenge>();
const MAX_PENDING_CHALLENGES = 64;

export async function withProductionTarget<A>(
  targetId: string,
  use: (target: PickerProofBoundTarget) => Promise<A>,
  signal?: AbortSignal,
  read: ProductionRead = readSshOwnerProductionOwner,
): Promise<A> {
  signal?.throwIfAborted();
  const live = read();
  if (!live) throw ownerFailure(new PickerProofOwnerError("ownerUnavailable"));
  const descriptor = await live.descriptorFor(targetId);
  if (!descriptorServesTarget(descriptor, targetId))
    throw ownerFailure(new PickerProofOwnerError("targetMismatch"));
  signal?.throwIfAborted();
  const target = live.handle.target(descriptor);
  try {
    return await use(target);
  } catch (error) {
    if (error instanceof SshTargetAuthRequiredError) throw error;
    // A password or encrypted-key target without its unlocked master: prompt in the app.
    if (error instanceof PickerProofOwnerError && error.code === "credentialRequired")
      throw (await credentialRequiredError(target, targetId)) ?? ownerFailure(error);
    if (error instanceof PickerProofOwnerError && error.code === "targetDisconnected")
      throw new RemoteTargetDisconnectedError(targetId);
    throw error instanceof PickerProofOwnerError ? ownerFailure(error) : error;
  }
}

/** A trust challenge the owner raised, exposed to the UI as an opaque id. */
async function hostTrustRequired(
  target: PickerProofBoundTarget,
  error: PickerProofOwnerError,
): Promise<never> {
  const trust = await target.inspectTrust();
  if (trust.state === "verified") throw error;
  const challengeId = `rust-owner:${randomBytes(32).toString("base64url")}`;
  if (challenges.size >= MAX_PENDING_CHALLENGES) challenges.clear();
  challenges.set(challengeId, {
    targetId: target.targetId,
    ownerToken: Uint8Array.from(trust.challenge),
  });
  throw new SshTargetAuthRequiredError(
    target.targetId,
    "host-trust",
    buildSshHostTrustRequiredMessage(
      JSON.stringify({
        challengeId,
        host: trust.jumpLeg ? `SSH jump route hop ${trust.jumpLeg}` : target.targetId,
        keyType: trust.keyType,
        fingerprint: trust.fingerprint,
      }),
    ),
  );
}

async function listOnTarget(
  target: PickerProofBoundTarget,
  input: ServerListRemoteFoldersInput,
): Promise<ServerListRemoteFoldersResult> {
  try {
    return await target.listRemoteFolders(input);
  } catch (error) {
    if (error instanceof PickerProofOwnerError && error.code === "trustRequired")
      return hostTrustRequired(target, error);
    throw error;
  }
}

export function listProductionRemoteFolders(
  input: ServerListRemoteFoldersInput,
  signal?: AbortSignal,
): Promise<ServerListRemoteFoldersResult> {
  return withProductionTarget(
    input.executionTargetId,
    (target) => listOnTarget(target, input),
    signal,
  );
}

/** The owner has no general verify verb: an authenticated listing proves access. */
export function verifyProductionTarget(input: {
  readonly executionTargetId: string;
  readonly cwd?: string;
}): Promise<{
  readonly executionTargetId: string;
  readonly message: string;
  readonly cwd: string;
}> {
  return withProductionTarget(input.executionTargetId, async (target) => {
    const { path } = await listOnTarget(target, {
      executionTargetId: input.executionTargetId,
      ...(input.cwd === undefined ? {} : { path: input.cwd }),
    });
    return {
      executionTargetId: input.executionTargetId,
      cwd: path,
      message: `Connected through the SSH owner. Remote path resolved to ${path}.`,
    };
  });
}

export async function trustProductionSshHost(
  input: ServerTrustSshHostInput,
): Promise<ServerTrustSshHostResult> {
  const pending = challenges.get(input.challengeId);
  challenges.delete(input.challengeId);
  if (!pending || pending.targetId !== input.executionTargetId) throw invalidChallenge();
  if (input.cancel) return { message: "SSH host trust request canceled." };
  return withProductionTarget(pending.targetId, async (target) => {
    try {
      const trust = await target.approveTrust(pending.ownerToken);
      if (trust.state !== "verified") throw new PickerProofOwnerError("protocolError");
      return { message: "SSH host trusted." };
    } catch (error) {
      if (error instanceof PickerProofOwnerError && error.code === "operationDenied")
        throw invalidChallenge();
      throw error;
    }
  });
}

/** Owner Connect/Disconnect rotate the target generation and close its master. */
export function transitionProductionTarget(
  executionTargetId: string,
  action: "connect" | "disconnect",
): Promise<{ readonly executionTargetId: string; readonly disconnected: boolean }> {
  return withProductionTarget(executionTargetId, async (target) => {
    const result = action === "connect" ? await target.connect() : await target.disconnect();
    if (result.state !== (action === "connect" ? "connected" : "disconnected"))
      throw ownerFailure(new PickerProofOwnerError("protocolError"));
    return { executionTargetId, disconnected: result.state === "disconnected" };
  });
}

/** Test-only reset of the pending challenge map. */
export function resetProductionPickerChallengesForTest(): void {
  challenges.clear();
}

/**
 * In-app password or key passphrase for one target (v1.credential.proto). The owner reads the
 * secret from its private per-lease socket; the buffer is zeroed after the write.
 */
export function unlockProductionSshCredential(input: {
  readonly executionTargetId: string;
  readonly credential: InAppCredential;
  readonly secret: Buffer;
}): Promise<{ readonly message: string }> {
  return withProductionTarget(input.executionTargetId, async (target) => {
    await unlockProductionCredential(target, input.credential, input.secret);
    return {
      message: input.credential === "password" ? "SSH password accepted." : "SSH key unlocked.",
    };
  }).finally(() => input.secret.fill(0));
}
