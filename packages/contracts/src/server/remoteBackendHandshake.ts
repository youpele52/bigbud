import { Schema } from "effect";

import { PositiveInt, TrimmedNonEmptyString } from "../core/baseSchemas";

// Remote backend handshake identity: schema only; the runtime is Phase 7 work.

/** Current `handshakeRevision` of the descriptor shape. */
export const REMOTE_BACKEND_HANDSHAKE_REVISION = 1;

/** Revision of the existing narrow mobile RPC surface, separate from full client RPC. */
export const REMOTE_BACKEND_MOBILE_RPC_REVISION = 1;

/** 128-bit random identity, lowercase hex. */
export const RemoteBackendAuthorityId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/));
export type RemoteBackendAuthorityId = typeof RemoteBackendAuthorityId.Type;

/** `sha256:` plus 64 lowercase hex characters. */
export const RemoteBackendSha256Fingerprint = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/),
);
export type RemoteBackendSha256Fingerprint = typeof RemoteBackendSha256Fingerprint.Type;

/**
 * Stable identity of one backend state root.
 * - `authorityId` is created once with the state root and persisted in it. It survives backend
 *   and agent version updates, restarts and host renames.
 * - `keyFingerprint` identifies the authority's current public key; it never derives from a path.
 * - `keyEpoch` starts at 1 and increments only on an explicit key rotation.
 */
export const RemoteBackendAuthority = Schema.Struct({
  authorityId: RemoteBackendAuthorityId,
  keyFingerprint: RemoteBackendSha256Fingerprint,
  keyEpoch: PositiveInt,
});
export type RemoteBackendAuthority = typeof RemoteBackendAuthority.Type;

/**
 * Opaque hash of (authorityId, machine identity, state-root device and inode), salted with the
 * authorityId so it cannot be correlated across authorities, and never revealing the path.
 *
 * A copied state directory keeps `authorityId` but gets a different fingerprint, which surfaces as
 * `duplicate-authority`. Legitimate changes produce the same verdict: an in-place move, a
 * filesystem migration or a container volume re-creation. Those need explicit user re-approval,
 * and UI copy should say the backend's installation changed rather than imply an attack.
 */
export const RemoteBackendInstallationFingerprint = RemoteBackendSha256Fingerprint;

/**
 * The only handshake shape the mobile gateway returns.
 *
 * Exposure rule: it is served before pairing to any tailnet peer (`GET /api/mobile/handshake`).
 * Every field must stay public-safe: random IDs, key fingerprints, salted hashes and versions.
 * Never add anything derived from usernames, filesystem paths, hostnames, ports, tokens or
 * capability lists.
 */
export const RemoteBackendMobileDescriptor = Schema.Struct({
  handshakeRevision: PositiveInt,
  authority: RemoteBackendAuthority,
  installationFingerprint: RemoteBackendInstallationFingerprint,
  backendVersion: TrimmedNonEmptyString,
  /** Mobile RPC revision served by this backend; the client checks its own supported range. */
  mobileRpcRevision: PositiveInt,
  mobileCapable: Schema.Boolean,
});
export type RemoteBackendMobileDescriptor = typeof RemoteBackendMobileDescriptor.Type;

/**
 * Client verdict when comparing a descriptor with the pin it holds for that origin. Pins are
 * keyed by `authorityId`; `installationFingerprint` is a guard. An origin with no pin is
 * `first-seen` before any comparison (the user approves pairing). Otherwise evaluate in order:
 * 1. `unsupported-revision`: handshake or mobile RPC revision outside the client's range; a newer
 *    descriptor shape is never interpreted.
 * 2. `authority-changed`: the origin now answers with a different `authorityId` than its pin
 *    (reused hostname, or a reinstall regenerated the authority). Reject and require re-pairing;
 *    never merge entries.
 * 3. `duplicate-authority`: same `authorityId`, different `installationFingerprint`. Reject until
 *    the user chooses which installation keeps the identity; the other must regenerate it.
 * 4. Key checks: `key-rotated` only for a higher `keyEpoch` together with a new fingerprint
 *    (never auto-accepted in v1). Any other key difference is `key-mismatch` (reject): a new
 *    fingerprint at the same or a lower epoch, or an epoch change with an unchanged fingerprint.
 * 5. `match` when all pinned fields are equal.
 */
export const RemoteBackendIdentityVerdict = Schema.Literals([
  "match",
  "first-seen",
  "key-rotated",
  "key-mismatch",
  "duplicate-authority",
  "authority-changed",
  "unsupported-revision",
]);
export type RemoteBackendIdentityVerdict = typeof RemoteBackendIdentityVerdict.Type;
