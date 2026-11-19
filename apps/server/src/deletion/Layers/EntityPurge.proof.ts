import type { ProjectId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import { replayCursorBehind } from "../../orchestration/Layers/OrchestrationEngine.replayCursors.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import type { makeEntityPurgeSql } from "./EntityPurge.sql.ts";

/**
 * Proves an entity's canonical history may be pruned: every deletion marker is covered by a
 * verified baseline, and every open domain-event stream in this process has read through the
 * history's last sequence. Pruning ahead of a stream records gap rows above its cursor, and its
 * next replay page then kills it (`OrchestrationEngine.domainEvents`): the reactor would stop
 * consuming events and never see the entity's deletion. Every pruning path runs this in the
 * transaction that deletes, so a failure leaves the history for that path's later retry.
 */
export const verifyCanonicalPurgeProof = Effect.fn("EntityPurge.verifyCanonicalProof")(
  function* (input: {
    readonly queries: ReturnType<typeof makeEntityPurgeSql>;
    readonly entityKind: "project" | "thread";
    readonly entityId: ProjectId | ThreadId;
  }) {
    const proof = (yield* input.queries.readCanonicalProof(input))[0] ?? {
      coveredByBaselineSequence: null,
      coveredMarkerCount: 0,
      deletionSequence: null,
      markerCount: 0,
      maxCanonicalSequence: 0,
    };
    if (
      proof.coveredByBaselineSequence === null ||
      proof.deletionSequence === null ||
      proof.markerCount === 0 ||
      proof.coveredMarkerCount !== proof.markerCount ||
      proof.deletionSequence > proof.coveredByBaselineSequence ||
      proof.maxCanonicalSequence > proof.coveredByBaselineSequence
    ) {
      return yield* toPersistenceSqlError("EntityPurge.verifyCanonicalReplay")(
        "entity deletion is not covered by a verified projection baseline",
      );
    }
    const behind = replayCursorBehind(proof.maxCanonicalSequence);
    if (behind !== null) {
      return yield* toPersistenceSqlError("EntityPurge.verifyReplayCursors")(
        `entity deletion history through sequence ${proof.maxCanonicalSequence} is ahead of an open domain event reader at sequence ${behind}`,
      );
    }
  },
);
