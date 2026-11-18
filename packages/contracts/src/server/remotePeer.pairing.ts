import * as Schema from "effect/Schema";

import { ProviderKind, RuntimeMode } from "../orchestration/orchestration.provider";
import { RemoteBackendAuthorityId, RemoteBackendSha256Fingerprint } from "./remoteBackendHandshake";
import { PeerGrantId, PeerWorkspaceRoot } from "./remotePeer";

/**
 * P8 coordinator pairing (M6 WP-8E). Schema only. A pairing is the coordinator's saved connection
 * to one worker (SSH host, user, explicitly confirmed host key pin) plus the grant the worker
 * issued for it. Revoking the grant is separate from deleting the saved connection: a revoked
 * pairing keeps its connection and pin so it can be re-granted, and deleting the connection never
 * revokes anything on the worker (the worker-side `bigbud peer revoke` does that).
 */
const Uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export const PeerPairingId = Schema.String.check(Schema.isPattern(Uuid));
export type PeerPairingId = typeof PeerPairingId.Type;

export const PeerSshHost = Schema.String.check(
  Schema.isPattern(/^(?!-)([A-Za-z0-9.-]{1,253}|[0-9A-Fa-f:]{2,39})$/),
);
export const PeerSshUser = Schema.String.check(Schema.isPattern(/^[a-z_][a-z0-9_.-]{0,31}$/));
export const PeerSshPort = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(65535),
);
/** `<type> <base64>`, as printed by `ssh-keyscan` without the host column. */
export const PeerPinnedHostKey = Schema.String.check(
  Schema.isPattern(
    /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa|rsa-sha2-(256|512)) [A-Za-z0-9+/]+={0,2}$/,
  ),
  Schema.isMaxLength(2048),
);

export const PeerPairingLabel = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9 ._@:-]{1,64}$/));

export const PeerPairingState = Schema.Literals(["awaiting-grant", "active", "revoked"]);
export type PeerPairingState = typeof PeerPairingState.Type;

/** Typed setup errors: terminal until the user fixes the pin or the grant, never retried. */
export const PeerSetupErrorCode = Schema.Literals([
  "host-identity-mismatch",
  "authentication-refused",
]);
export type PeerSetupErrorCode = typeof PeerSetupErrorCode.Type;

export const PeerSetupError = Schema.Struct({
  code: PeerSetupErrorCode,
  message: Schema.String.check(Schema.isMaxLength(1024)),
  at: Schema.String,
});
export type PeerSetupError = typeof PeerSetupError.Type;

export const PeerPairing = Schema.Struct({
  pairingId: PeerPairingId,
  label: PeerPairingLabel,
  workerAuthorityId: RemoteBackendAuthorityId,
  host: PeerSshHost,
  port: PeerSshPort,
  user: PeerSshUser,
  pinnedHostKey: PeerPinnedHostKey,
  /** `SHA256:<base64>` of the pinned key, as `ssh-keygen -lf` prints it. */
  hostKeyFingerprint: Schema.String.check(Schema.isMaxLength(128)),
  hostKeyConfirmedAt: Schema.String,
  workspaceRoot: PeerWorkspaceRoot,
  provider: ProviderKind,
  runtimeMode: RuntimeMode,
  /** The coordinator key fingerprint the grant command binds. */
  coordinatorKeyFingerprint: RemoteBackendSha256Fingerprint,
  grantId: Schema.NullOr(PeerGrantId),
  grantRecordedAt: Schema.NullOr(Schema.String),
  grantRevokedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type PeerPairing = typeof PeerPairing.Type;

export const PeerPairingView = Schema.Struct({
  ...PeerPairing.fields,
  state: PeerPairingState,
  /** Exact worker command that issues the grant (run on the worker). */
  grantCommand: Schema.String,
  /** Exact worker command that revokes the recorded grant; null until a grant is recorded. */
  revokeCommand: Schema.NullOr(Schema.String),
  setupError: Schema.NullOr(PeerSetupError),
  /** Dispatches to this worker that have not settled yet. */
  unsettledDispatches: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type PeerPairingView = typeof PeerPairingView.Type;

export const PeerScannedHostKey = Schema.Struct({
  pinnedHostKey: PeerPinnedHostKey,
  fingerprint: Schema.String.check(Schema.isMaxLength(128)),
});
export type PeerScannedHostKey = typeof PeerScannedHostKey.Type;

export const PeerPairingRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("status") }),
  /** Generates the dedicated coordinator key on first use, then reuses it. */
  Schema.Struct({ action: Schema.Literal("ensure-key") }),
  /** Reads the worker's host keys for the user to compare; nothing is pinned yet. */
  Schema.Struct({
    action: Schema.Literal("scan-host-key"),
    host: PeerSshHost,
    port: PeerSshPort,
  }),
  Schema.Struct({
    action: Schema.Literal("save"),
    label: PeerPairingLabel,
    workerAuthorityId: RemoteBackendAuthorityId,
    host: PeerSshHost,
    port: PeerSshPort,
    user: PeerSshUser,
    pinnedHostKey: PeerPinnedHostKey,
    /** The user explicitly confirmed this exact pin; nothing is saved without it. */
    confirmPin: Schema.Literal(true),
    workspaceRoot: PeerWorkspaceRoot,
    provider: ProviderKind,
    runtimeMode: RuntimeMode,
  }),
  Schema.Struct({
    action: Schema.Literal("record-grant"),
    pairingId: PeerPairingId,
    grantId: PeerGrantId,
  }),
  Schema.Struct({ action: Schema.Literal("revoke"), pairingId: PeerPairingId }),
  Schema.Struct({ action: Schema.Literal("delete-connection"), pairingId: PeerPairingId }),
]);
export type PeerPairingRequest = typeof PeerPairingRequest.Type;

export const PeerCoordinatorKey = Schema.Struct({
  authorityId: Schema.NullOr(RemoteBackendAuthorityId),
  publicKey: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
  publicKeyFile: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))),
  fingerprint: Schema.NullOr(RemoteBackendSha256Fingerprint),
});
export type PeerCoordinatorKey = typeof PeerCoordinatorKey.Type;

export const PeerPairingResult = Schema.Struct({
  coordinator: PeerCoordinatorKey,
  pairings: Schema.Array(PeerPairingView).check(Schema.isMaxLength(64)),
  scannedHostKeys: Schema.optional(Schema.Array(PeerScannedHostKey).check(Schema.isMaxLength(8))),
});
export type PeerPairingResult = typeof PeerPairingResult.Type;

export const PeerPairingErrorCode = Schema.Literals([
  "unavailable",
  "invalid-request",
  "key-unavailable",
  "host-key-scan-failed",
  "pairing-unknown",
  "pairing-busy",
  "pairing-conflict",
]);
export type PeerPairingErrorCode = typeof PeerPairingErrorCode.Type;

export class PeerPairingError extends Schema.TaggedErrorClass<PeerPairingError>()(
  "PeerPairingError",
  { code: PeerPairingErrorCode, message: Schema.String },
) {}
