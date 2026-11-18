import { Schema } from "effect";
import { remoteAgentConnectionWarningFields } from "./remoteAgentInstall.registry.connection.ts";
import { RemoteAgentRuntimeSchema } from "./remoteAgentRuntime.ts";
import { MobileRegistrySchema } from "./remoteAgentInstall.mobile.schema.ts";

export const BuildSchema = Schema.Struct({
  id: Schema.String,
  runtime: RemoteAgentRuntimeSchema,
  health: Schema.Literals(["staged", "healthy", "quarantined"]),
  promotion: Schema.Number,
  binary: Schema.Literals(["present", "deleting", "absent"]),
  authenticated: Schema.Boolean,
});
const PinSchema = Schema.Struct({ owner: Schema.String, buildId: Schema.String });
const StageSchema = Schema.Struct({
  id: Schema.String,
  buildId: Schema.String,
  phase: Schema.Literals(["reserved", "published", "cancelled", "failed"]),
  controllerId: Schema.optional(Schema.String),
  controllerPid: Schema.optional(Schema.Number),
  controllerStartedAt: Schema.optional(Schema.String),
  reservedAt: Schema.optional(Schema.Number),
  leaseExpiresAt: Schema.optional(Schema.Number),
  failure: Schema.optional(Schema.Literals(["definitive", "ambiguous"])),
});
const LaunchSchema = Schema.Struct({
  attemptId: Schema.optional(Schema.String),
  id: Schema.String,
  buildId: Schema.String,
  phase: Schema.Literals(["reserved", "spawn-uncertain", "ready", "proven-dead"]),
  epoch: Schema.String,
});
const AdmissionRetirementSchema = Schema.Struct({
  ...remoteAgentConnectionWarningFields,
  id: Schema.String,
  buildId: Schema.String,
  epoch: Schema.String,
  outcome: Schema.Literals(["selected", "fallback", "rejected"]),
  requestedBuildId: Schema.optional(Schema.String),
  failureCode: Schema.optional(Schema.String),
});
export const SlotReservationSchema = Schema.Struct({
  id: Schema.String,
  /** Stable physical slot identity; old v2 rows derive it from their id. */
  slotId: Schema.optional(Schema.String),
  requestId: Schema.String,
  buildId: Schema.String,
  phase: Schema.Literals(["reserved", "occupied", "released"]),
  controllerId: Schema.optional(Schema.String),
});
const UpdateIdentitySchema = Schema.Struct({
  version: Schema.String,
  sha256: Schema.String,
  buildDigest: Schema.String,
  targetTriple: Schema.String,
});
export const UpdateSchema = Schema.Struct({
  requestId: Schema.String,
  buildId: Schema.String,
  phase: Schema.Literals([
    "waiting-for-capacity",
    "reserved",
    "installing",
    "checking",
    "ready-for-reconnect",
    "failed",
    "uncertain",
    "promoted",
  ]),
  outcome: Schema.optional(
    Schema.Literals(["capacity", "installed", "ready", "failed", "uncertain"]),
  ),
  identity: Schema.optional(UpdateIdentitySchema),
  reason: Schema.optional(Schema.String),
  epoch: Schema.optional(Schema.String),
  predecessorBuildId: Schema.optional(Schema.String),
});
export const RetirementReservationSchema = Schema.Struct({
  id: Schema.String,
  buildId: Schema.String,
  generation: Schema.String,
  phase: Schema.Literals([
    "reserved",
    "fenced",
    "shutdown-requested",
    "exited",
    "tombstoned",
    "failed",
  ]),
  expectedEpoch: Schema.optional(Schema.String),
  controllerId: Schema.optional(Schema.String),
  failure: Schema.optional(Schema.String),
});
export const RestartReservationSchema = Schema.Struct({
  id: Schema.String,
  buildId: Schema.String,
  generation: Schema.String,
  expectedEpoch: Schema.String,
  phase: Schema.Literals(["reserved", "stopping", "stopped", "starting", "ready", "failed"]),
});
const registryFields = {
  revision: Schema.Number,
  promotionSequence: Schema.Number,
  builds: Schema.Array(BuildSchema),
  pins: Schema.Array(PinSchema),
  stages: Schema.Array(StageSchema),
  launches: Schema.Array(LaunchSchema),
  admissions: Schema.Array(
    Schema.Struct({
      ...remoteAgentConnectionWarningFields,
      id: Schema.String,
      buildId: Schema.String,
      phase: Schema.Literals(["prepared", "ready"]),
      epoch: Schema.String,
      outcome: Schema.optional(Schema.Literals(["selected", "fallback"])),
      requestedBuildId: Schema.optional(Schema.String),
      failureCode: Schema.optional(Schema.String),
    }),
  ),
  admissionRetirements: Schema.optional(Schema.Array(AdmissionRetirementSchema)),
  slotReservations: Schema.Array(SlotReservationSchema),
  updates: Schema.Array(UpdateSchema),
  retirementReservations: Schema.Array(RetirementReservationSchema),
  restartReservations: Schema.Array(RestartReservationSchema),
  pending: Schema.NullOr(Schema.String),
  current: Schema.NullOr(Schema.String),
  predecessor: Schema.NullOr(Schema.String),
  currentConnectionId: Schema.NullOr(Schema.String),
};

export const RemoteAgentRegistryV2Schema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  ...registryFields,
});
export const RemoteAgentRegistryV3Schema = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  ...registryFields,
  admissionRetirements: Schema.Array(AdmissionRetirementSchema),
  mobile: MobileRegistrySchema,
});
