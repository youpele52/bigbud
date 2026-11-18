import * as Schema from "effect/Schema";

import { ThreadId } from "../core/baseSchemas";
import { ProviderKind, RuntimeMode } from "../orchestration/orchestration.provider";
import { RemoteBackendAuthorityId, RemoteBackendSha256Fingerprint } from "./remoteBackendHandshake";

/**
 * P8 peer orchestration (M6 WP-8A). Schema only; no endpoints or transport yet.
 *
 * A coordinator backend delegates work to a worker backend. The worker stores the grant it issued
 * to a coordinator (`peer_grants`); the coordinator stores one durable dispatch per delegated child
 * (`peer_dispatches`). An uncertain send is never relaunched: retries reuse the same dispatch
 * identity and namespaced command id, which the worker deduplicates through command receipts.
 */
const Uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const UuidSource = Uuid.source.slice(1, -1);

export const PeerGrantId = Schema.String.check(Schema.isPattern(Uuid));
export type PeerGrantId = typeof PeerGrantId.Type;

export const PeerDispatchId = Schema.String.check(Schema.isPattern(Uuid));
export type PeerDispatchId = typeof PeerDispatchId.Type;

/** The worker peer socket allow-list (WP-8B). Nothing else is reachable through a grant. */
export const PeerAction = Schema.Literals(["delegate", "status", "follow", "cancel"]);
export type PeerAction = typeof PeerAction.Type;

export const PeerActions = Schema.Array(PeerAction).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4),
  Schema.isUnique(),
);
export type PeerActions = typeof PeerActions.Type;

/** An absolute workspace root on the worker host. Paths are never shared across hosts. */
export const PeerWorkspaceRoot = Schema.String.check(
  Schema.isPattern(/^\//),
  Schema.makeFilter((path) => !path.includes("\u0000")),
  Schema.isMaxLength(4096),
);
export type PeerWorkspaceRoot = typeof PeerWorkspaceRoot.Type;

/**
 * Least-privilege runtime order used for narrowing: a grant or request may only stay at the same
 * position or move left. Kept beside the schema so every side ranks modes identically.
 */
export const PEER_RUNTIME_MODE_ORDER = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
] as const satisfies ReadonlyArray<typeof RuntimeMode.Type>;

/**
 * What a peer may do on the worker. A worker grant's ceiling is narrower than or equal to the
 * worker's own local policy, and every dispatch's permissions are narrower than or equal to both
 * the grant ceiling and the coordinator thread's own permissions (the caller's narrower
 * permissions propagate). Narrowing means: runtime mode at or below, providers a subset, and
 * workspace roots a subset.
 */
export const PeerPermissionCeiling = Schema.Struct({
  runtimeMode: RuntimeMode,
  providers: Schema.Array(ProviderKind).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
    Schema.isUnique(),
  ),
  workspaceRoots: Schema.Array(PeerWorkspaceRoot).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
    Schema.isUnique(),
  ),
});
export type PeerPermissionCeiling = typeof PeerPermissionCeiling.Type;

/**
 * Worker-side grant. It binds the coordinator's authority and current key fingerprint (D10:
 * coordinator-generated SSH key, worker forced command limited to the peer socket), so a key
 * rotation or reinstalled coordinator needs a new grant. Revocation is independent from deleting
 * any local saved connection; account-level SSH access remains the outer trust boundary.
 */
export const PeerGrant = Schema.Struct({
  grantId: PeerGrantId,
  coordinatorAuthorityId: RemoteBackendAuthorityId,
  coordinatorKeyFingerprint: RemoteBackendSha256Fingerprint,
  workerAuthorityId: RemoteBackendAuthorityId,
  actions: PeerActions,
  ceiling: PeerPermissionCeiling,
  issuedAt: Schema.String,
  expiresAt: Schema.String,
  revokedAt: Schema.NullOr(Schema.String),
});
export type PeerGrant = typeof PeerGrant.Type;

/** `peer:<coordinator authorityId>:<dispatchId>`; namespaced so worker receipts never collide. */
export const PeerDispatchCommandId = Schema.String.check(
  Schema.isPattern(new RegExp(`^peer:[0-9a-f]{32}:${UuidSource}$`)),
);
export type PeerDispatchCommandId = typeof PeerDispatchCommandId.Type;

/** Idempotency key of the coordinator request (for example a hashed tool invocation id). */
export const PeerDispatchRequestKey = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9:._-]{1,128}$/),
);
export type PeerDispatchRequestKey = typeof PeerDispatchRequestKey.Type;

export const PeerWorkerTarget = Schema.Struct({
  workerAuthorityId: RemoteBackendAuthorityId,
  grantId: PeerGrantId,
  workspaceRoot: PeerWorkspaceRoot,
  provider: ProviderKind,
});
export type PeerWorkerTarget = typeof PeerWorkerTarget.Type;

/** The durable identity of one delegated child. One identity launches at most one child. */
export const PeerDispatchIdentity = Schema.Struct({
  dispatchId: PeerDispatchId,
  commandId: PeerDispatchCommandId,
  coordinatorAuthorityId: RemoteBackendAuthorityId,
  coordinatorThreadId: ThreadId,
  requestKey: PeerDispatchRequestKey,
  worker: PeerWorkerTarget,
});
export type PeerDispatchIdentity = typeof PeerDispatchIdentity.Type;

/**
 * Coordinator-side dispatch states.
 *
 * | from           | to             | when                                                      |
 * | -------------- | -------------- | --------------------------------------------------------- |
 * | pending        | sent-uncertain | the record is durable and the delegate request goes out   |
 * | pending        | failed         | refused locally before sending (no grant, bad permission) |
 * | pending        | cancelled      | cancelled before anything reached the worker              |
 * | sent-uncertain | accepted       | the worker receipt names the child (send or status probe) |
 * | sent-uncertain | failed         | the worker definitively refused this dispatch identity    |
 * | sent-uncertain | cancel-pending | cancel requested while acceptance is unknown              |
 * | accepted       | following      | the coordinator started following the child               |
 * | accepted       | completed      | the child had already finished when first observed        |
 * | accepted       | failed         | the child had already failed when first observed          |
 * | accepted       | cancel-pending | cancel requested before following started                 |
 * | following      | completed      | bounded result summary delivered                          |
 * | following      | failed         | the child failed or the worker reported a terminal error  |
 * | following      | cancel-pending | cancel requested while following                          |
 * | cancel-pending | cancelled      | the worker confirmed the cancellation                      |
 * | cancel-pending | completed      | the child finished before the cancel landed (truth wins)  |
 * | cancel-pending | failed         | the child failed before the cancel landed                 |
 *
 * Never legal: any move back to `pending` or `sent-uncertain` (that would relaunch), leaving
 * `cancel-pending` except to a terminal state (cancel intent is durable; silence is not
 * cancellation), and any move out of `completed`, `failed` or `cancelled`. Retrying a send keeps
 * the state at `sent-uncertain` and reuses the same command id.
 */
export const PeerDispatchState = Schema.Literals([
  "pending",
  "sent-uncertain",
  "accepted",
  "following",
  "completed",
  "failed",
  "cancel-pending",
  "cancelled",
]);
export type PeerDispatchState = typeof PeerDispatchState.Type;

export const PEER_DISPATCH_TERMINAL_STATES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies ReadonlyArray<PeerDispatchState>;

/** Legal transitions, mirrored by the table above. */
export const PeerDispatchTransition = Schema.Literals([
  "pending->sent-uncertain",
  "pending->failed",
  "pending->cancelled",
  "sent-uncertain->accepted",
  "sent-uncertain->failed",
  "sent-uncertain->cancel-pending",
  "accepted->following",
  "accepted->completed",
  "accepted->failed",
  "accepted->cancel-pending",
  "following->completed",
  "following->failed",
  "following->cancel-pending",
  "cancel-pending->cancelled",
  "cancel-pending->completed",
  "cancel-pending->failed",
]);
export type PeerDispatchTransition = typeof PeerDispatchTransition.Type;

export const PeerErrorCode = Schema.Literals([
  "grant-missing",
  "grant-expired",
  "grant-revoked",
  "authority-mismatch",
  "action-not-allowed",
  "permission-exceeds-ceiling",
  "worker-unreachable",
  "dispatch-conflict",
  "dispatch-unknown",
  "illegal-transition",
  "result-too-large",
  "child-failed",
]);
export type PeerErrorCode = typeof PeerErrorCode.Type;

export const PeerError = Schema.Struct({
  code: PeerErrorCode,
  message: Schema.String.check(Schema.isMaxLength(1024)),
});
export type PeerError = typeof PeerError.Type;

export const PEER_RESULT_SUMMARY_MAX_CHARS = 8192;
export const PEER_RESULT_MAX_ATTACHMENTS = 8;

/** An explicit attachment the worker offers; content transfer is separate and bounded. */
export const PeerResultAttachment = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  mediaType: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type PeerResultAttachment = typeof PeerResultAttachment.Type;

/** Bounded child result; repositories are never synchronized and paths are never assumed shared. */
export const PeerResultSummary = Schema.Struct({
  outcome: Schema.Literals(["completed", "failed", "cancelled"]),
  summary: Schema.String.check(Schema.isMaxLength(PEER_RESULT_SUMMARY_MAX_CHARS)),
  /** The worker cut the summary down to the bound. */
  truncated: Schema.Boolean,
  attachments: Schema.Array(PeerResultAttachment).check(
    Schema.isMaxLength(PEER_RESULT_MAX_ATTACHMENTS),
  ),
});
export type PeerResultSummary = typeof PeerResultSummary.Type;

/** Coordinator-side dispatch record (migration 175 `peer_dispatches`). */
export const PeerDispatch = Schema.Struct({
  ...PeerDispatchIdentity.fields,
  /** Effective permissions: narrower than or equal to the grant ceiling and the caller's own. */
  permissions: PeerPermissionCeiling,
  state: PeerDispatchState,
  sendAttempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  childThreadId: Schema.NullOr(ThreadId),
  cancelRequestedAt: Schema.NullOr(Schema.String),
  result: Schema.NullOr(PeerResultSummary),
  error: Schema.NullOr(PeerError),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type PeerDispatch = typeof PeerDispatch.Type;
