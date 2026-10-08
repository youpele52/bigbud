import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { ProviderTurnAdmissions } from "../Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "./ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { admissionFixture } from "./ProviderTurnAdmissions.test.ts";
import { insertProjectionThreadParent } from "./ProjectionThread.test.helpers.ts";

const layer = ProviderTurnAdmissionsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
it.layer(layer)("admission retention deletion fence", (it) => {
  it.effect(
    "deletion tombstone blocks new dispatch/replay while retained records remain readable and compactable",
    () =>
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        const sql = yield* SqlClient.SqlClient;
        const input = admissionFixture("owner-delete");
        let row = yield* journal.reserve(input);
        row = yield* journal.transition(row, "dispatch-intent", row.createdAt);
        row = yield* journal.transition(row, "accepted", row.createdAt);
        row = yield* journal.transition(
          row,
          "terminal",
          row.createdAt,
          "retained ".repeat(1000),
          "completed",
        );
        const reserved = yield* journal.reserve(admissionFixture("pending-owner-delete"));
        yield* sql`INSERT INTO orchestration_deletion_markers (entity_kind, entity_id, deletion_sequence, deleted_at) VALUES ('thread', ${input.ownerThreadId}, 1, ${row.createdAt})`;
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(journal.assertOwnerAvailable(input.ownerThreadId))),
        );
        assert.isTrue(Exit.isFailure(yield* Effect.exit(journal.reserve(input))));
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(journal.reserve(admissionFixture("new-after-delete")))),
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(journal.transition(reserved, "dispatch-intent", row.createdAt)),
          ),
        );
        assert.equal(yield* journal.compactTerminal(1), 1);
        assert.deepEqual(yield* journal.find(input), row);
        assert.equal((yield* journal.find(reserved))?.state, "reserved");
        assert.equal(
          (yield* sql`SELECT entity_id FROM orchestration_deletion_markers WHERE entity_id = ${input.ownerThreadId}`)
            .length,
          1,
        );
      }),
  );
  it.effect(
    "a deleting owner is denied before native admission but its accepted loss can still terminalize",
    () =>
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("deleting-owner");
        yield* insertProjectionThreadParent({ sql, threadId });
        const fixture = admissionFixture("deleting-accepted");
        const input = {
          ...fixture,
          ownerThreadId: threadId,
          binding: { ...fixture.binding, threadId },
        };
        let row = yield* journal.reserve(input);
        row = yield* journal.transition(row, "dispatch-intent", row.createdAt);
        row = yield* journal.transition(row, "accepted", row.createdAt);
        yield* sql`UPDATE projection_threads SET deleting_at = ${row.createdAt} WHERE thread_id = ${threadId}`;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(journal.assertOwnerAvailable(threadId))));
        assert.equal(
          (yield* journal.transition(row, "terminal", row.createdAt, undefined, "interrupted"))
            .terminalOutcome,
          "interrupted",
        );
      }),
  );
});
