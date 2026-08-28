import { Schema } from "effect";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "../core/baseSchemas";

export const GetThreadOwnershipInput = Schema.Struct({ threadId: ThreadId });
export type GetThreadOwnershipInput = typeof GetThreadOwnershipInput.Type;

const CanonicalThreadOwnership = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  serverEpoch: Schema.String,
  canonicalRevision: NonNegativeInt,
});

export const GetThreadOwnershipResult = Schema.Union([
  CanonicalThreadOwnership.pipe(
    Schema.fieldsAssign({
      status: Schema.Literals(["active", "archived", "deleting"]),
    }),
  ),
  CanonicalThreadOwnership.pipe(
    Schema.fieldsAssign({
      status: Schema.Literal("deleted"),
      reusePolicy: Schema.Literal("explicit-create-after-deletion"),
    }),
  ),
  Schema.Struct({
    threadId: ThreadId,
    status: Schema.Literal("absent"),
    serverEpoch: Schema.String,
    canonicalRevision: NonNegativeInt,
    reusePolicy: Schema.Literal("canonical-identity-unclaimed"),
  }),
  Schema.Struct({
    threadId: ThreadId,
    status: Schema.Literal("unavailable"),
    ownership: Schema.Literals(["confirmed", "unconfirmed"]),
    reason: TrimmedNonEmptyString,
    projectId: Schema.optional(ProjectId),
    serverEpoch: Schema.optional(Schema.String),
    canonicalRevision: Schema.optional(NonNegativeInt),
  }),
]);
export type GetThreadOwnershipResult = typeof GetThreadOwnershipResult.Type;
