import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "../core/baseSchemas";
import { ProviderKind } from "../orchestration/orchestration.provider";
import { RemoteBackendAuthorityId, RemoteBackendSha256Fingerprint } from "./remoteBackendHandshake";
import {
  PeerActions,
  PeerDispatchCommandId,
  PeerDispatchId,
  PeerError,
  PeerGrant,
  PeerGrantId,
  PeerPermissionCeiling,
  PeerResultSummary,
  PeerWorkspaceRoot,
} from "./remotePeer";
import { PEER_FOLLOW_MAX_WAIT_MS } from "../constants/remotePeer.constant";

/**
 * P8 worker peer endpoint wire shapes (M6 WP-8B/8C). Schema only; paths, header names and bounds
 * live in `constants/remotePeer.constant.ts` so the forced-command helper stays schema-free.
 */
export const PeerDelegateRequest = Schema.Struct({
  dispatchId: PeerDispatchId,
  /** Coordinator-side origin, recorded for audit; never resolved on the worker. */
  coordinatorThreadId: ThreadId,
  workspaceRoot: PeerWorkspaceRoot,
  provider: ProviderKind,
  /** Provider model slug; the worker's provider default when absent. */
  model: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  /** Narrower than or equal to the grant ceiling; never widened by the worker. */
  permissions: PeerPermissionCeiling,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(32_000)),
});
export type PeerDelegateRequest = typeof PeerDelegateRequest.Type;

export const PeerDispatchRef = Schema.Struct({ dispatchId: PeerDispatchId });
export type PeerDispatchRef = typeof PeerDispatchRef.Type;

export const PeerFollowRequest = Schema.Struct({
  dispatchId: PeerDispatchId,
  waitMs: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(PEER_FOLLOW_MAX_WAIT_MS),
  ),
});
export type PeerFollowRequest = typeof PeerFollowRequest.Type;

/** `waiting` means the child needs an approval or user input on the worker. */
export const PeerChildState = Schema.Literals([
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);
export type PeerChildState = typeof PeerChildState.Type;

export const PeerChildStatus = Schema.Struct({
  dispatchId: PeerDispatchId,
  commandId: PeerDispatchCommandId,
  childThreadId: ThreadId,
  state: PeerChildState,
  /** The worker's workflow label (for example `awaiting_approval`), for display only. */
  workflowStatus: Schema.String.check(Schema.isMaxLength(64)),
  cancelRequested: Schema.Boolean,
  /** Present once the child is terminal. */
  result: Schema.NullOr(PeerResultSummary),
});
export type PeerChildStatus = typeof PeerChildStatus.Type;

export const PeerDelegateResponse = Schema.Struct({
  ...PeerChildStatus.fields,
  /** The dispatch identity was already known; no second child was created. */
  replayed: Schema.Boolean,
});
export type PeerDelegateResponse = typeof PeerDelegateResponse.Type;

export const PeerErrorResponse = Schema.Struct({ error: PeerError });
export type PeerErrorResponse = typeof PeerErrorResponse.Type;

/** Owner-only grant administration over the authenticated client socket (`bigbud peer`). */
export const PeerGrantOwnerRequest = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("issue"),
    authorityId: RemoteBackendAuthorityId,
    coordinatorAuthorityId: RemoteBackendAuthorityId,
    coordinatorKeyFingerprint: RemoteBackendSha256Fingerprint,
    actions: PeerActions,
    ceiling: PeerPermissionCeiling,
    expiresAt: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("revoke"),
    authorityId: RemoteBackendAuthorityId,
    grantId: PeerGrantId,
  }),
  Schema.Struct({ action: Schema.Literal("list"), authorityId: RemoteBackendAuthorityId }),
]);
export type PeerGrantOwnerRequest = typeof PeerGrantOwnerRequest.Type;

export const PeerGrantOwnerResult = Schema.Struct({
  grants: Schema.Array(PeerGrant).check(Schema.isMaxLength(256)),
});
export type PeerGrantOwnerResult = typeof PeerGrantOwnerResult.Type;

export const PeerGrantOwnerRefusalCode = Schema.Literals([
  "invalid-request",
  "authority-mismatch",
  "exceeds-ceiling",
  "unknown-grant",
  "unavailable",
]);
export type PeerGrantOwnerRefusalCode = typeof PeerGrantOwnerRefusalCode.Type;

export const PeerGrantOwnerRefusal = Schema.Struct({ refused: PeerGrantOwnerRefusalCode });
export type PeerGrantOwnerRefusal = typeof PeerGrantOwnerRefusal.Type;
