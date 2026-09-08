import { Schema } from "effect";
import {
  RemoteAgentRuntimeSchema,
  validateRemoteAgentRuntime,
  remoteAgentBuildId,
} from "./remoteAgentRuntime.ts";

const BuildSchema = Schema.Struct({
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
  id: Schema.String,
  buildId: Schema.String,
  epoch: Schema.String,
  outcome: Schema.Literals(["selected", "fallback", "rejected"]),
  requestedBuildId: Schema.optional(Schema.String),
  failureCode: Schema.optional(Schema.String),
});
const SlotReservationSchema = Schema.Struct({
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
const UpdateSchema = Schema.Struct({
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
  epoch: Schema.optional(Schema.String),
  predecessorBuildId: Schema.optional(Schema.String),
});
const RetirementReservationSchema = Schema.Struct({
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
export const RemoteAgentRegistrySchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  revision: Schema.Number,
  promotionSequence: Schema.Number,
  builds: Schema.Array(BuildSchema),
  pins: Schema.Array(PinSchema),
  stages: Schema.Array(StageSchema),
  launches: Schema.Array(LaunchSchema),
  admissions: Schema.Array(
    Schema.Struct({
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
  pending: Schema.NullOr(Schema.String),
  current: Schema.NullOr(Schema.String),
  predecessor: Schema.NullOr(Schema.String),
  currentConnectionId: Schema.NullOr(Schema.String),
});
export type RemoteAgentRegistry = typeof RemoteAgentRegistrySchema.Type;
export type RemoteAgentRegistryBuild = typeof BuildSchema.Type;
export type RemoteAgentSlotReservation = typeof SlotReservationSchema.Type;
export type RemoteAgentUpdate = typeof UpdateSchema.Type;
export type RemoteAgentRetirementReservation = typeof RetirementReservationSchema.Type;
export const MAX_REMOTE_AGENT_REGISTRY_BYTES = 1024 * 1024;
export const MAX_REMOTE_AGENT_BUILDS = 32;
export const MAX_REMOTE_AGENT_PINS = 128;
export const MAX_REMOTE_AGENT_STAGES = 64;
export const MAX_REMOTE_AGENT_LAUNCHES = 64;
export const MAX_REMOTE_AGENT_ADMISSIONS = 64;
/** Retired admission IDs are never evicted; a full fence rejects new requests safely. */
export const MAX_REMOTE_AGENT_ADMISSION_RETIREMENTS = 256;
export const MAX_REMOTE_AGENT_ID_LENGTH = 128;
export const MAX_REMOTE_AGENT_TERMINAL_OWNERS = 256;
export const REMOTE_AGENT_STAGE_LEASE_MS = 5 * 60 * 1000;
export const REMOTE_AGENT_SLOT_IDS = ["slot-0", "slot-1"] as const;

const printable = (value: string, label: string, max = MAX_REMOTE_AGENT_ID_LENGTH): void => {
  if (value.length === 0 || value.length > max || !/^[\x21-\x7e]+$/.test(value))
    throw new Error(`Invalid registry ${label}.`);
};

export function emptyRemoteAgentRegistry(): RemoteAgentRegistry {
  return {
    schemaVersion: 2,
    revision: 0,
    promotionSequence: 0,
    builds: [],
    pins: [],
    stages: [],
    launches: [],
    admissions: [],
    admissionRetirements: [],
    slotReservations: [],
    updates: [],
    retirementReservations: [],
    pending: null,
    current: null,
    predecessor: null,
    currentConnectionId: null,
  };
}

/** Metadata is authority, not a best-effort cache: corrupt or unknown versions fail closed. */
export function parseRemoteAgentRegistry(text: string): RemoteAgentRegistry {
  if (Buffer.byteLength(text) > MAX_REMOTE_AGENT_REGISTRY_BYTES)
    throw new Error("Registry is full.");
  const raw = JSON.parse(text) as Record<string, unknown>;
  const migrated =
    raw.schemaVersion === 1
      ? {
          ...raw,
          schemaVersion: 2,
          slotReservations: [],
          updates: [],
          retirementReservations: [],
          predecessor: null,
        }
      : raw;
  const state = Schema.decodeUnknownSync(RemoteAgentRegistrySchema)({
    ...migrated,
    admissionRetirements: migrated.admissionRetirements ?? [],
    slotReservations: migrated.slotReservations ?? [],
    updates: migrated.updates ?? [],
    retirementReservations: migrated.retirementReservations ?? [],
    predecessor: migrated.predecessor ?? null,
  });
  if (
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !Number.isSafeInteger(state.promotionSequence) ||
    state.promotionSequence < 0
  ) {
    throw new Error("Invalid registry revision.");
  }
  if (
    state.builds.length > MAX_REMOTE_AGENT_BUILDS ||
    state.pins.length > MAX_REMOTE_AGENT_PINS ||
    state.stages.length > MAX_REMOTE_AGENT_STAGES ||
    state.launches.length > MAX_REMOTE_AGENT_LAUNCHES ||
    state.admissions.length > MAX_REMOTE_AGENT_ADMISSIONS ||
    (state.admissionRetirements?.length ?? 0) > MAX_REMOTE_AGENT_ADMISSION_RETIREMENTS ||
    state.slotReservations.length > MAX_REMOTE_AGENT_BUILDS ||
    state.updates.length > MAX_REMOTE_AGENT_ADMISSIONS ||
    state.retirementReservations.length > MAX_REMOTE_AGENT_BUILDS
  )
    throw new Error("Remote agent registry record budget exceeded.");
  const ids = new Set<string>();
  const generations = new Set<string>();
  for (const build of state.builds) {
    printable(build.id, "build id");
    const runtime = validateRemoteAgentRuntime(build.runtime);
    if (build.id !== remoteAgentBuildId(runtime) || ids.has(build.id)) {
      throw new Error("Invalid or duplicate registry build.");
    }
    ids.add(build.id);
    if (generations.has(runtime.generation))
      throw new Error("Runtime generation is shared by distinct builds.");
    generations.add(runtime.generation);
    if (
      !Number.isSafeInteger(build.promotion) ||
      build.promotion < 0 ||
      build.promotion > state.promotionSequence ||
      (build.health === "healthy" && build.promotion === 0)
    )
      throw new Error("Invalid promotion.");
  }
  for (const collection of [state.pins, state.stages, state.launches]) {
    const owners = new Set<string>();
    for (const reference of collection) {
      const owner = "owner" in reference ? reference.owner : reference.id;
      printable(owner, "reference id", 256);
      if (owners.has(owner) || !ids.has(reference.buildId)) {
        throw new Error("Invalid registry reference.");
      }
      owners.add(owner);
    }
  }
  const reservationIds = new Set<string>();
  const activeSlotIds = new Set<string>();
  for (const reservation of state.slotReservations) {
    printable(reservation.id, "slot reservation id", 256);
    printable(reservation.requestId, "update request id", 256);
    printable(reservation.buildId, "slot reservation build id");
    const slotId = reservation.slotId ?? reservation.id.split(":", 1)[0] ?? "";
    if (
      reservationIds.has(reservation.id) ||
      !ids.has(reservation.buildId) ||
      !REMOTE_AGENT_SLOT_IDS.includes(slotId as (typeof REMOTE_AGENT_SLOT_IDS)[number]) ||
      (reservation.phase !== "released" && activeSlotIds.has(slotId)) ||
      (reservation.controllerId !== undefined && !reservation.controllerId)
    )
      throw new Error("Invalid or duplicate slot reservation.");
    reservationIds.add(reservation.id);
    if (reservation.phase !== "released") activeSlotIds.add(slotId);
    if (reservation.controllerId !== undefined)
      printable(reservation.controllerId, "slot controller id", 256);
  }
  const updateIds = new Set<string>();
  for (const update of state.updates) {
    printable(update.requestId, "update request id", 256);
    printable(update.buildId, "update build id");
    if (updateIds.has(update.requestId) || !ids.has(update.buildId))
      throw new Error("Invalid or duplicate update request.");
    updateIds.add(update.requestId);
    if (update.identity) {
      printable(update.identity.version, "candidate version");
      printable(update.identity.sha256, "candidate hash");
      printable(update.identity.buildDigest, "candidate build digest", 256);
      printable(update.identity.targetTriple, "candidate target triple");
    }
    if (update.epoch !== undefined) printable(update.epoch, "candidate epoch", 256);
    if (update.predecessorBuildId !== undefined) {
      printable(update.predecessorBuildId, "candidate predecessor");
      if (!ids.has(update.predecessorBuildId)) throw new Error("Unknown update predecessor.");
    }
  }
  const retirementIds = new Set<string>();
  for (const retirement of state.retirementReservations) {
    printable(retirement.id, "retirement reservation id", 256);
    printable(retirement.buildId, "retirement build id");
    printable(retirement.generation, "retirement generation");
    if (retirementIds.has(retirement.id) || !ids.has(retirement.buildId))
      throw new Error("Invalid or duplicate retirement reservation.");
    retirementIds.add(retirement.id);
    if (retirement.expectedEpoch !== undefined)
      printable(retirement.expectedEpoch, "retirement epoch", 256);
    if (retirement.controllerId !== undefined)
      printable(retirement.controllerId, "retirement controller id", 256);
    if (retirement.failure !== undefined) printable(retirement.failure, "retirement failure", 256);
  }
  for (const stage of state.stages) {
    if (
      (stage.controllerId === undefined) !==
      (stage.controllerPid === undefined || stage.controllerStartedAt === undefined)
    ) {
      throw new Error("Incomplete staging controller identity.");
    }
    if (
      stage.controllerPid !== undefined &&
      (!Number.isSafeInteger(stage.controllerPid) || stage.controllerPid <= 0)
    )
      throw new Error("Invalid staging controller PID.");
    if (stage.controllerId !== undefined) printable(stage.controllerId, "controller id", 256);
    if (stage.controllerStartedAt !== undefined)
      printable(stage.controllerStartedAt, "controller start token", 256);
    for (const [label, value] of [
      ["reserved timestamp", stage.reservedAt],
      ["stage lease expiry", stage.leaseExpiresAt],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
        throw new Error(`Invalid ${label}.`);
    }
    if (stage.phase === "failed" && !stage.failure)
      throw new Error("Failed stage has no failure outcome.");
    if (stage.phase !== "failed" && stage.failure)
      throw new Error("Only failed stages may have a failure outcome.");
  }
  const admissionIds = new Set<string>();
  for (const admission of state.admissions) {
    if (admission.requestedBuildId) printable(admission.requestedBuildId, "requested build");
    if (admission.failureCode) printable(admission.failureCode, "admission failure", 64);
    printable(admission.id, "admission id");
    printable(admission.buildId, "admission build id");
    if (admissionIds.has(admission.id) || !ids.has(admission.buildId))
      throw new Error("Invalid or duplicate registry admission.");
    admissionIds.add(admission.id);
    if (admission.phase === "prepared" && admission.epoch !== "")
      throw new Error("Prepared admission has an epoch.");
    if (admission.phase === "ready") {
      printable(admission.epoch, "admission epoch", 256);
      const launch = state.launches.find(
        (entry) =>
          entry.buildId === admission.buildId &&
          (entry.phase === "ready" || entry.phase === "proven-dead"),
      );
      if (!launch || launch.epoch !== admission.epoch)
        throw new Error("Ready admission has no matching launch.");
    }
  }
  const retiredAdmissionIds = new Set<string>();
  for (const retirement of state.admissionRetirements ?? []) {
    printable(retirement.id, "retired admission id");
    printable(retirement.buildId, "retired admission build id");
    if (retirement.epoch) printable(retirement.epoch, "retired admission epoch", 256);
    if (retirement.requestedBuildId)
      printable(retirement.requestedBuildId, "retired requested build");
    if (retirement.failureCode) printable(retirement.failureCode, "retired admission failure", 64);
    if (admissionIds.has(retirement.id) || retiredAdmissionIds.has(retirement.id))
      throw new Error("Duplicate admission retirement.");
    retiredAdmissionIds.add(retirement.id);
  }
  for (const selector of [state.current, state.pending, state.predecessor]) {
    if (selector !== null) {
      printable(selector, "selector");
      if (!ids.has(selector)) throw new Error("Unknown registry selector.");
    }
  }
  if (state.currentConnectionId !== null) {
    printable(state.currentConnectionId, "current connection id");
    const currentAdmission = state.admissions.find(
      (entry) => entry.id === state.currentConnectionId && entry.phase === "ready",
    );
    if (!currentAdmission || currentAdmission.buildId !== state.current)
      throw new Error("Current connection does not match a ready admission.");
  }
  return state;
}
