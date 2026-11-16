import { generateKeyPair, randomBytes, sign, type KeyObject } from "node:crypto";
import { promisify } from "node:util";

import type { RemoteBackendAuthority } from "@bigbud/contracts/server/remoteBackendHandshake.ts";

import type { BackendInstanceShape } from "../startup/backendInstance.ts";
import {
  ensurePrivateRemoteStateRoot,
  publishPrivateAuthority,
  readPrivateAuthority,
} from "./authority.files.ts";
import {
  decodeAuthorityRecord,
  installationFingerprint,
  keyFingerprint,
  RemoteBackendAuthorityError,
  type AuthorityRecord,
} from "./authority.record.ts";

import {
  makeNativeLeaseCapabilityDerivation,
  type NativeLeaseCapabilityDerivation,
} from "./authority.nativeLeaseCapability.ts";

const generate = promisify(generateKeyPair);
const inFlight = new Map<string, Promise<RemoteBackendIdentity>>();

export interface RemoteBackendIdentity {
  readonly authority: RemoteBackendAuthority;
  readonly installationFingerprint: string;
  readonly publicKey: KeyObject;
  /** Internal only; synthetic/legacy identities intentionally cannot activate native leases. */
  readonly deriveNativeLeaseCapability?: NativeLeaseCapabilityDerivation;
  readonly signChallenge: (challenge: Uint8Array) => Uint8Array;
}

type AuthorityOwner = Pick<BackendInstanceShape, "stateDir" | "machineId" | "nonce" | "assertHeld">;

async function loadIdentity(
  owner: AuthorityOwner,
  requireExisting: boolean,
): Promise<RemoteBackendIdentity> {
  await owner.assertHeld();
  if (!owner.machineId) {
    throw new RemoteBackendAuthorityError(
      "unsafe-state",
      "A stable machine identity is required for a remote backend.",
    );
  }
  const root = await ensurePrivateRemoteStateRoot(owner.stateDir);
  let raw = await readPrivateAuthority(owner.stateDir);
  if (raw === undefined) {
    if (requireExisting)
      throw new RemoteBackendAuthorityError(
        "invalid-identity",
        "The existing account service authority is missing. Preserve the installation and restore it explicitly; no replacement identity was generated.",
      );
    const { privateKey, publicKey } = await generate("ed25519");
    const authorityId = randomBytes(16).toString("hex");
    const record: AuthorityRecord = {
      version: 1,
      authority: { authorityId, keyEpoch: 1, keyFingerprint: keyFingerprint(publicKey) },
      installationFingerprint: installationFingerprint(authorityId, owner.machineId, root),
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
    await publishPrivateAuthority(owner.stateDir, `${JSON.stringify(record)}\n`, owner.assertHeld);
    raw = await readPrivateAuthority(owner.stateDir);
    if (raw === undefined)
      throw new RemoteBackendAuthorityError(
        "owner-changed",
        "The remote identity publication was lost.",
      );
  }
  const { record, privateKey, publicKey } = decodeAuthorityRecord(raw);
  if (
    record.installationFingerprint !==
    installationFingerprint(record.authority.authorityId, owner.machineId, root)
  ) {
    throw new RemoteBackendAuthorityError(
      "installation-changed",
      "The remote backend installation changed. Re-approve or repair its identity explicitly.",
    );
  }
  await owner.assertHeld();
  return {
    authority: Object.freeze({
      authorityId: record.authority.authorityId,
      keyEpoch: record.authority.keyEpoch,
      keyFingerprint: record.authority.keyFingerprint,
    }),
    installationFingerprint: record.installationFingerprint,
    publicKey,
    deriveNativeLeaseCapability: makeNativeLeaseCapabilityDerivation(privateKey),
    signChallenge: (challenge) => {
      if (challenge.byteLength === 0 || challenge.byteLength > 4096) {
        throw new RemoteBackendAuthorityError(
          "invalid-identity",
          "The authority challenge size is invalid.",
        );
      }
      return sign(
        null,
        Buffer.concat([Buffer.from("bigbud.remote-backend.challenge.v1\0"), challenge]),
        privateKey,
      );
    },
  };
}

/** The existing state-root lock is the writer authority; concurrent calls only share initialization. */
export function loadRemoteBackendIdentity(
  owner: AuthorityOwner,
  options: { readonly requireExisting?: boolean } = {},
): Promise<RemoteBackendIdentity> {
  const requireExisting = options.requireExisting === true;
  const key = `${owner.stateDir}\0${owner.nonce}\0${requireExisting ? "existing" : "create"}`;
  const current = inFlight.get(key);
  if (current) return current;
  const promise = loadIdentity(owner, requireExisting).finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}
