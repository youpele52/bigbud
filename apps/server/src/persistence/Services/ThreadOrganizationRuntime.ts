import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ServiceMap from "effect/ServiceMap";

import type { ProjectionRepositoryError } from "../Errors.ts";

const Uint = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const OptionalTime = Schema.NullOr(Uint);
export const OrganizationRuntimePolicy = Schema.Struct({
  policyVersion: Uint,
  policyFingerprint: Schema.String,
  shortFingerprint: Schema.String,
  olderFingerprint: Schema.String,
  targetFingerprint: Schema.String,
  shortPolicyChangedAtMs: OptionalTime,
  olderPolicyChangedAtMs: OptionalTime,
  targetDrainNotBeforeMs: OptionalTime,
  onboardingDecision: Schema.Literal("existing-opt-in"),
  onboardingVersion: Schema.Literal(1),
  canonicalFrontier: Uint,
});
export type OrganizationRuntimePolicy = typeof OrganizationRuntimePolicy.Type;
export const ReconcileOrganizationPolicy = Schema.Struct({
  /** Initial native observation is not a change to the existing older-thread policy. */
  initialize: Schema.optionalKey(Schema.Boolean),
  expectedPolicyVersion: Uint,
  policyFingerprint: Identity,
  shortFingerprint: Identity,
  olderFingerprint: Identity,
  targetFingerprint: Identity,
  nowMs: Uint,
  graceMs: Uint,
});
export type ReconcileOrganizationPolicy = typeof ReconcileOrganizationPolicy.Type;
export const OrganizationRuntimeThread = Schema.Struct({
  threadId: Identity,
  factVersion: Uint,
  sourceFrontier: Uint,
  transitionDigest: Schema.String,
  lastWorkCompletedAtMs: OptionalTime,
  deliberateOrganizationAtMs: OptionalTime,
  manualUntilMs: OptionalTime,
  attentionWatermark: Uint,
  graceUntilMs: OptionalTime,
  latestAutomaticMoveId: Schema.NullOr(Identity),
  deleted: Schema.Literals([0, 1]),
});
export type OrganizationRuntimeThread = typeof OrganizationRuntimeThread.Type;
export type RuntimeWriteStatus = "applied" | "duplicate" | "stale" | "conflict";

export interface ThreadOrganizationRuntimeRepositoryShape {
  readonly readPolicy: () => Effect.Effect<OrganizationRuntimePolicy, ProjectionRepositoryError>;
  readonly reconcilePolicy: (input: ReconcileOrganizationPolicy) => Effect.Effect<
    {
      readonly status: RuntimeWriteStatus;
      readonly policy: OrganizationRuntimePolicy;
    },
    ProjectionRepositoryError
  >;
  readonly readThread: (
    threadId: string,
  ) => Effect.Effect<OrganizationRuntimeThread | undefined, ProjectionRepositoryError>;
  // Per-thread rows are written only by the canonical organisation hook and the fact store
  // (thread-organization/organizationFacts.events.ts and .store.ts): one owner, no second path.
}
export class ThreadOrganizationRuntimeRepository extends ServiceMap.Service<
  ThreadOrganizationRuntimeRepository,
  ThreadOrganizationRuntimeRepositoryShape
>()("bigbud/persistence/ThreadOrganizationRuntimeRepository") {}
