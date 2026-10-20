import { Schema, ServiceMap } from "effect";
import type * as Effect from "effect/Effect";
import type { PersistenceSqlError, PersistenceDecodeError } from "../Errors.ts";

const Bounded = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
export const OpencodeV2SharedBinding = Schema.Struct({
  threadId: Bounded,
  nativeSessionId: Bounded,
  storageIdentity: Bounded,
  directory: Bounded,
  runtimeTargetId: Bounded,
  workspaceTargetId: Bounded,
  identityKind: Schema.Literals(["shared-api-v1", "adopted-legacy-v1", "shared-api-v2"]),
  profileIssuer: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  registrationFamily: Schema.optionalKey(Schema.Literals(["legacy", "scoped"])),
  material: Bounded,
  state: Schema.Literals(["reserved", "dispatch-intent", "verified"]),
  revision: Schema.Number,
}).check(
  Schema.makeFilter((row) =>
    row.identityKind === "shared-api-v2"
      ? row.profileIssuer !== undefined && row.registrationFamily === "scoped"
      : row.profileIssuer === undefined &&
        (row.registrationFamily === undefined || row.registrationFamily === "legacy"),
  ),
);
export type OpencodeV2SharedBinding = typeof OpencodeV2SharedBinding.Type;
export const V2_SHARED_BINDING_CONFLICT_DETAILS = {
  legacy: "Shared binding material/state conflict; history retained, no replay.",
  invalidMaterial: "Shared binding reservation material is invalid; history retained, no replay.",
  missingReservation: "Shared binding reservation is unavailable; history retained, no replay.",
  materialMismatch:
    "Shared binding reservation differs from retained material; history retained, no replay.",
  invalidTransition:
    "Shared binding transition is not permitted from its retained state; history retained, no replay.",
  staleTransition:
    "Shared binding transition lost its exact revision/material check; history retained, no replay.",
} as const;
export class OpencodeV2SharedBindingConflict extends Schema.TaggedErrorClass<OpencodeV2SharedBindingConflict>()(
  "OpencodeV2SharedBindingConflict",
  { detail: Schema.String },
) {}
export type SharedBindingError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | OpencodeV2SharedBindingConflict;
export interface OpencodeV2SharedBindingsShape {
  readonly find: (
    threadId: string,
  ) => Effect.Effect<OpencodeV2SharedBinding | undefined, SharedBindingError>;
  readonly reserve: (
    input: Omit<OpencodeV2SharedBinding, "state" | "revision">,
  ) => Effect.Effect<OpencodeV2SharedBinding, SharedBindingError>;
  readonly transition: (
    row: OpencodeV2SharedBinding,
    state: "dispatch-intent" | "verified",
  ) => Effect.Effect<OpencodeV2SharedBinding, SharedBindingError>;
  readonly hasRecords: Effect.Effect<boolean, SharedBindingError>;
}
export class OpencodeV2SharedBindings extends ServiceMap.Service<
  OpencodeV2SharedBindings,
  OpencodeV2SharedBindingsShape
>()("bigbud/persistence/OpencodeV2SharedBindings") {}
