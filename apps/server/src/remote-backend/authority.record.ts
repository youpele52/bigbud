import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import type { BigIntStats } from "node:fs";

import type { RemoteBackendAuthority } from "@bigbud/contracts/server/remoteBackendHandshake.ts";

export class RemoteBackendAuthorityError extends Error {
  readonly _tag = "RemoteBackendAuthorityError";

  constructor(
    readonly code: "unsafe-state" | "invalid-identity" | "installation-changed" | "owner-changed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RemoteBackendAuthorityError";
  }
}

export interface AuthorityRecord {
  readonly version: 1;
  readonly authority: RemoteBackendAuthority;
  readonly installationFingerprint: string;
  readonly privateKey: string;
}

export const keyFingerprint = (key: KeyObject): string =>
  `sha256:${createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex")}`;

/** Names and paths are deliberately absent: the guard follows the agreed installation tuple. */
export function installationFingerprint(authorityId: string, machineId: string, root: BigIntStats) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify([authorityId, machineId, root.dev.toString(), root.ino.toString()]))
    .digest("hex")}`;
}

export function decodeAuthorityRecord(raw: string) {
  try {
    const record: AuthorityRecord = JSON.parse(raw);
    if (
      typeof record !== "object" ||
      record === null ||
      Array.isArray(record) ||
      typeof record.authority !== "object" ||
      record.authority === null ||
      Array.isArray(record.authority) ||
      record.version !== 1 ||
      typeof record.authority.authorityId !== "string" ||
      typeof record.authority.keyFingerprint !== "string" ||
      typeof record.installationFingerprint !== "string" ||
      !/^[0-9a-f]{32}$/.test(record.authority.authorityId) ||
      !Number.isSafeInteger(record.authority.keyEpoch) ||
      record.authority.keyEpoch < 1 ||
      typeof record.privateKey !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(record.installationFingerprint)
    ) {
      throw new Error("Invalid authority record shape.");
    }
    const privateKey = createPrivateKey(record.privateKey);
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("Unsupported authority key type.");
    }
    const publicKey = createPublicKey(privateKey);
    if (keyFingerprint(publicKey) !== record.authority.keyFingerprint) {
      throw new Error("Authority key fingerprint mismatch.");
    }
    return { record, privateKey, publicKey };
  } catch {
    // Neither the private key nor untrusted record contents belong in a surfaced error.
    throw new RemoteBackendAuthorityError(
      "invalid-identity",
      "The remote backend identity is invalid. Preserve it and repair the installation explicitly.",
    );
  }
}
