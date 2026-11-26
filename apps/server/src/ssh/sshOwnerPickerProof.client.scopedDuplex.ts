import { createHash } from "node:crypto";
import type {
  PeerRelayOwnerLease,
  PeerRelaySshOwner,
} from "../remote-backend/peerRelay.ssh.owner.ts";
import { makeProofDuplexClient } from "./sshOwnerPickerProof.client.agentProxy.ts";
import { proofRelayLease } from "./sshOwnerPickerProof.client.relay.ts";
import {
  validateProofGitAdvertisement,
  validateProofGitUpload,
  type PickerProofGitUploadFixture,
  validateProofPeerFixture,
  type PickerProofGitAdvertisementFixture,
  type PickerProofPeerFixture,
} from "./sshOwnerPickerProof.codec.scopedDuplex.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

type Channels = Parameters<typeof makeProofDuplexClient>[2];
type Execute = Parameters<typeof makeProofDuplexClient>[3];

function equal<T extends object>(actual: T, expected: T) {
  return (Object.keys(expected) as Array<keyof T>).every((key) => actual[key] === expected[key]);
}

export function makeProofPeerRelay(
  targetId: string,
  fixture: PickerProofPeerFixture | undefined,
  dial: { readonly host: string; readonly port: number; readonly user: string },
  take: Channels,
  execute: Execute,
) {
  const open = makeProofDuplexClient<{ executionTargetId: string; scope: PickerProofPeerFixture }>(
    targetId,
    ({ scope }) =>
      fixture && equal(validateProofPeerFixture(scope), fixture)
        ? { kind: "openProofPeerRelay", ...fixture }
        : undefined,
    take,
    execute,
  );
  return async (
    request: Parameters<PeerRelaySshOwner["openPeerRelay"]>[0],
    signal: AbortSignal,
  ): Promise<PeerRelayOwnerLease> => {
    signal.throwIfAborted();
    if (request.recipe !== "paired-peer-forced-command")
      throw new PickerProofOwnerError("invalidOperands");
    const pairing = request.pairing;
    const pinned = /^ssh-ed25519 ([A-Za-z0-9+/]{68})$/.exec(pairing.pinnedHostKey)?.[1];
    if (
      pairing.host !== dial.host ||
      pairing.port !== dial.port ||
      pairing.user !== dial.user ||
      !pinned ||
      `SHA256:${createHash("sha256").update(Buffer.from(pinned, "base64")).digest("base64").replace(/=+$/, "")}` !==
        pairing.hostKeyFingerprint
    ) {
      throw new PickerProofOwnerError("operationDenied");
    }
    return proofRelayLease(
      await open({ executionTargetId: targetId, scope: request.pairing }, signal),
    );
  };
}

export interface ProofGitAdvertisementInput extends PickerProofGitAdvertisementFixture {
  readonly executionTargetId: string;
}

/** Advertisement-only byte stream. It is not a Git push or a writable receive-pack lease. */
export function makeProofGitAdvertisement(
  targetId: string,
  fixture: PickerProofGitAdvertisementFixture | undefined,
  take: Channels,
  execute: Execute,
) {
  return makeProofDuplexClient<ProofGitAdvertisementInput>(
    targetId,
    (input) =>
      fixture && equal(validateProofGitAdvertisement(input), fixture)
        ? { kind: "openProofGitAdvertisement", ...fixture }
        : undefined,
    take,
    execute,
  );
}

/** Bidirectional read service. This scope cannot select a writable Git command. */
export function makeProofGitUpload(
  targetId: string,
  fixture: PickerProofGitUploadFixture | undefined,
  take: Channels,
  execute: Execute,
) {
  return makeProofDuplexClient<PickerProofGitUploadFixture & { executionTargetId: string }>(
    targetId,
    (input) =>
      fixture && equal(validateProofGitUpload(input), fixture)
        ? { kind: "openProofGitUpload", ...fixture }
        : undefined,
    take,
    execute,
  );
}
