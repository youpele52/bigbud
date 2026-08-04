import type { ProjectId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import type { makeEntityPurgeSql } from "./EntityPurge.sql.ts";

export const verifyCanonicalPurgeProof = Effect.fn("EntityPurge.verifyCanonicalProof")(
  function* (input: {
    readonly queries: ReturnType<typeof makeEntityPurgeSql>;
    readonly entityKind: "project" | "thread";
    readonly entityId: ProjectId | ThreadId;
  }) {
    const proof = (yield* input.queries.readCanonicalProof(input))[0] ?? {
      coveredByBaselineSequence: null,
      deletionSequence: null,
      maxCanonicalSequence: 0,
    };
    if (
      proof.coveredByBaselineSequence === null ||
      proof.deletionSequence === null ||
      proof.deletionSequence > proof.coveredByBaselineSequence ||
      proof.maxCanonicalSequence > proof.coveredByBaselineSequence
    ) {
      return yield* toPersistenceSqlError("EntityPurge.verifyCanonicalReplay")(
        "entity deletion is not covered by a verified projection baseline",
      );
    }
  },
);
