import { assert, it } from "@effect/vitest";
import { Effect, Layer, Exit } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { ProviderTurnAdmissions } from "../Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "./ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { admissionFixture } from "./ProviderTurnAdmissions.test.ts";

const layer = ProviderTurnAdmissionsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
it.layer(layer)("bounded retained admission evidence", (it) => {
  it.effect(
    "pages stable immutable keys without skipping mutable-state updates or crossing owners",
    () =>
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        for (let index = 0; index < 205; index++)
          yield* journal.reserve(admissionFixture(`page-${String(index).padStart(3, "0")}`));
        const other = admissionFixture("other-owner");
        yield* journal.reserve({
          ...other,
          binding: { ...other.binding, threadId: ThreadId.makeUnsafe("other") },
        });
        const first = yield* journal.listBoundPage({
          threadId: ThreadId.makeUnsafe("owner-1"),
          limit: 100,
        });
        yield* journal.transition(first.at(-1)!, "dispatch-intent", "2099-01-01T00:00:00.000Z");
        const second = yield* journal.listBoundPage({
          threadId: ThreadId.makeUnsafe("owner-1"),
          limit: 100,
          after: first.at(-1)!,
        });
        const third = yield* journal.listBoundPage({
          threadId: ThreadId.makeUnsafe("owner-1"),
          limit: 100,
          after: second.at(-1)!,
        });
        assert.strictEqual(
          new Set([...first, ...second, ...third].map((row) => row.requestMessageId)).size,
          205,
        );
        assert.strictEqual(third.length, 5);
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              journal.listBoundPage({ threadId: other.binding.threadId, limit: 0 }),
            ),
          ),
        );
      }),
  );
  it.effect(
    "losslessly compacts only terminal payloads and never changes replay/learning identity or outcomes",
    () =>
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        const sql = yield* SqlClient.SqlClient;
        const input = admissionFixture("compact");
        let row = yield* journal.reserve(input);
        row = yield* journal.transition(row, "dispatch-intent", row.createdAt);
        row = yield* journal.transition(row, "accepted", row.createdAt);
        const text = "durable unicode 🧠 evidence\n".repeat(10000);
        const terminal = yield* journal.transition(
          row,
          "terminal",
          row.createdAt,
          text,
          "completed",
        );
        const unresolved = yield* journal.reserve(admissionFixture("retain-unknown"));
        yield* journal.transition(unresolved, "dispatch-intent", unresolved.createdAt);
        assert.strictEqual(yield* journal.compactTerminal(1), 1);
        assert.deepEqual(yield* journal.find(input), terminal);
        assert.deepEqual(yield* journal.reserve(input), terminal);
        assert.strictEqual((yield* journal.find(unresolved))?.state, "dispatch-intent");
        assert.strictEqual(yield* journal.compactTerminal(1), 0);
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(journal.transition(terminal, "dispatch-intent", row.createdAt)),
          ),
        );
        const stored = yield* sql<{
          encoding: string;
          bytes: number;
        }>`SELECT final_text_encoding AS encoding, length(final_text) AS bytes FROM provider_turn_admissions WHERE request_message_id = ${input.requestMessageId}`;
        assert.strictEqual(stored[0]?.encoding, "gzip");
        assert.isTrue(stored[0]!.bytes < text.length);
        yield* sql`UPDATE provider_turn_admissions SET final_text = 'corrupt', final_text_encoding = 'gzip' WHERE request_message_id = ${input.requestMessageId}`;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(journal.find(input))));
      }),
  );
});
