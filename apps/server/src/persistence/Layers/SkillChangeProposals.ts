import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  SkillChangeProposal,
  SkillChangeProposalRepository,
  type SkillChangeProposalRepositoryShape,
} from "../Services/SkillChangeProposals.ts";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const getRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ proposalId: Schema.String }),
    Result: SkillChangeProposal,
    execute: ({ proposalId }) => sql`
      SELECT proposal_id AS "proposalId", thread_id AS "threadId", turn_id AS "turnId",
        provider, skill_path AS "skillPath", original_hash AS "originalHash",
        old_text AS "oldText", new_text AS "newText", reason, status,
        created_at AS "createdAt", resolved_at AS "resolvedAt"
      FROM skill_change_proposals WHERE proposal_id = ${proposalId} LIMIT 1
    `,
  });

  const create: SkillChangeProposalRepositoryShape["create"] = (row) =>
    sql`
      INSERT INTO skill_change_proposals (
        proposal_id, thread_id, turn_id, provider, skill_path, original_hash,
        old_text, new_text, reason, status, created_at, resolved_at
      ) VALUES (
        ${row.proposalId}, ${row.threadId}, ${row.turnId}, ${row.provider}, ${row.skillPath},
        ${row.originalHash}, ${row.oldText}, ${row.newText}, ${row.reason}, ${row.status},
        ${row.createdAt}, ${row.resolvedAt}
      )
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("SkillChangeProposal.create")));

  const getById: SkillChangeProposalRepositoryShape["getById"] = (proposalId) =>
    getRow({ proposalId }).pipe(
      Effect.mapError(toPersistenceSqlError("SkillChangeProposal.getById")),
    );

  const resolve: SkillChangeProposalRepositoryShape["resolve"] = (input) =>
    sql`
      UPDATE skill_change_proposals SET status = ${input.status}, resolved_at = ${input.resolvedAt}
      WHERE proposal_id = ${input.proposalId} AND status = 'pending'
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("SkillChangeProposal.resolve")));

  return { create, getById, resolve } satisfies SkillChangeProposalRepositoryShape;
});

export const SkillChangeProposalRepositoryLive = Layer.effect(SkillChangeProposalRepository, make);
