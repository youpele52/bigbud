import { MessageId, ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Exit } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProviderTurnAdmissions } from "../Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "./ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

export const admissionFixture = (request = "request-1") => ({
  namespace: "foreground" as const,
  ownerThreadId: ThreadId.makeUnsafe("owner-1"),
  requestMessageId: MessageId.makeUnsafe(request),
  binding: {
    provider: "opencodeV2",
    threadId: ThreadId.makeUnsafe("owner-1"),
    nativeSessionId: "ses_fixture",
    location: "/synthetic",
    runtimeTargetId: "local",
    workspaceTargetId: "local",
    storageIdentity: "isolated-profile",
  },
  fingerprint: "immutable-input-digest",
  nativeAdmissionId: `msg_${request}`,
  turnId: TurnId.makeUnsafe(`turn-${request}`),
  createdAt: "2026-09-30T00:00:00.000Z",
});

const layer = ProviderTurnAdmissionsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.layer(layer)("durable provider turn admissions", (it) => {
  it.effect("reserves once concurrently and rejects conflicting material/provider rebinding", () =>
    Effect.gen(function* () {
      const journal = yield* ProviderTurnAdmissions;
      const input = admissionFixture("concurrent");
      const rows = yield* Effect.all([journal.reserve(input), journal.reserve(input)], {
        concurrency: 2,
      });
      assert.deepEqual(rows[0], rows[1]);
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(journal.reserve({ ...input, fingerprint: "changed" }))),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            journal.reserve({ ...input, binding: { ...input.binding, provider: "opencode" } }),
          ),
        ),
      );
    }),
  );

  it.effect(
    "only one stale-fenced reservation can claim dispatch and terminal cannot resurrect",
    () =>
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        const reserved = yield* journal.reserve(admissionFixture("fenced"));
        const intent = yield* journal.transition(reserved, "dispatch-intent", reserved.createdAt);
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(journal.transition(reserved, "dispatch-intent", reserved.createdAt)),
          ),
        );
        const accepted = yield* journal.transition(intent, "accepted", reserved.createdAt);
        const terminal = yield* journal.transition(
          accepted,
          "terminal",
          reserved.createdAt,
          "full final text",
        );
        assert.deepEqual(yield* journal.reserve(admissionFixture("fenced")), terminal);
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(journal.transition(terminal, "dispatch-intent", reserved.createdAt)),
          ),
        );
        assert.strictEqual((yield* journal.find(terminal))?.finalText, "full final text");
      }),
  );

  it.effect("evidence survives unrelated binding removal and scans are bounded", () =>
    Effect.gen(function* () {
      const journal = yield* ProviderTurnAdmissions;
      const sql = yield* SqlClient.SqlClient;
      const row = yield* journal.reserve(admissionFixture("retained"));
      yield* journal.transition(row, "dispatch-intent", row.createdAt);
      yield* sql`DELETE FROM provider_session_runtime WHERE thread_id = ${row.binding.threadId}`;
      assert.strictEqual((yield* journal.find(row))?.state, "dispatch-intent");
      assert.strictEqual((yield* journal.listUnresolved(1)).length, 1);
      for (const limit of [0, -1, 1001, 1.5]) {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(journal.listUnresolved(limit))));
      }
    }),
  );

  it.effect("invalid input fails before writing and corrupt persisted data fails closed", () =>
    Effect.gen(function* () {
      const journal = yield* ProviderTurnAdmissions;
      const sql = yield* SqlClient.SqlClient;
      const input = admissionFixture("corrupt");
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            journal.reserve({ ...input, binding: { ...input.binding, nativeSessionId: "" } }),
          ),
        ),
      );
      assert.isUndefined(yield* journal.find(input));
      yield* journal.reserve(input);
      yield* sql`UPDATE provider_turn_admissions SET binding_json = 'invalid' WHERE request_message_id = ${input.requestMessageId}`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(journal.find(input))));
    }),
  );
});
