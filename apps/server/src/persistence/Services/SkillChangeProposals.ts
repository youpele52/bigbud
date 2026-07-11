import { ProviderKind, ThreadId, TrimmedNonEmptyString, TurnId } from "@bigbud/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const SkillChangeProposalStatus = Schema.Literals([
  "pending",
  "applied",
  "rejected",
  "stale",
]);
export type SkillChangeProposalStatus = typeof SkillChangeProposalStatus.Type;

export const SkillChangeProposal = Schema.Struct({
  proposalId: TrimmedNonEmptyString,
  threadId: ThreadId,
  turnId: TurnId,
  provider: ProviderKind,
  skillPath: TrimmedNonEmptyString,
  originalHash: TrimmedNonEmptyString,
  oldText: TrimmedNonEmptyString,
  newText: TrimmedNonEmptyString,
  reason: TrimmedNonEmptyString,
  status: SkillChangeProposalStatus,
  createdAt: Schema.String,
  resolvedAt: Schema.NullOr(Schema.String),
});
export type SkillChangeProposal = typeof SkillChangeProposal.Type;

export interface SkillChangeProposalRepositoryShape {
  readonly create: (proposal: SkillChangeProposal) => Effect.Effect<void, PersistenceSqlError>;
  readonly getById: (
    proposalId: string,
  ) => Effect.Effect<
    Option.Option<SkillChangeProposal>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly resolve: (input: {
    readonly proposalId: string;
    readonly status: Exclude<SkillChangeProposalStatus, "pending">;
    readonly resolvedAt: string;
  }) => Effect.Effect<void, PersistenceSqlError>;
}

export class SkillChangeProposalRepository extends ServiceMap.Service<
  SkillChangeProposalRepository,
  SkillChangeProposalRepositoryShape
>()("t3/persistence/Services/SkillChangeProposals/SkillChangeProposalRepository") {}
