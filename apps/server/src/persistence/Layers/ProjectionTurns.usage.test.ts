import { ThreadId, MessageId, TurnId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectionTurnRepositoryLive } from "./ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../Services/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { insertProjectionThreadParent } from "./ProjectionThread.test.helpers.ts";

it.layer(ProjectionTurnRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "usage attribution",
  (it) => {
    it.effect("freezes explicit pending attribution and preserves it through later upserts", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* ProjectionTurnRepository;
        const threadId = ThreadId.makeUnsafe("frozen-attribution");
        yield* insertProjectionThreadParent({ sql, threadId });
        const usageAttribution = {
          provider: "codex",
          model: "requested-model",
          interactionMode: "plan" as const,
        };
        yield* repository.replacePendingTurnStart({
          threadId,
          messageId: MessageId.makeUnsafe("prompt"),
          requestedAt: "2026-10-01T00:00:00.000Z",
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          usageAttribution,
        });
        const pending = yield* repository.getPendingTurnStartByThreadId({ threadId });
        assert.isTrue(Option.isSome(pending));
        if (Option.isNone(pending)) return;
        assert.deepEqual(pending.value.usageAttribution, usageAttribution);
        const turn = {
          threadId,
          turnId: TurnId.makeUnsafe("turn"),
          pendingMessageId: pending.value.messageId,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: null,
          state: "running" as const,
          requestedAt: pending.value.requestedAt,
          startedAt: pending.value.requestedAt,
          completedAt: null,
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        };
        yield* repository.upsertByTurnId({ ...turn, usageAttribution });
        yield* repository.upsertByTurnId({
          ...turn,
          state: "completed",
          pendingMessageId: null,
          requestedAt: "2026-10-02T00:00:00.000Z",
        });
        const restored = yield* repository.getByTurnId({ threadId, turnId: turn.turnId });
        assert.isTrue(Option.isSome(restored));
        if (Option.isSome(restored)) {
          assert.deepEqual(restored.value.usageAttribution, usageAttribution);
          assert.equal(restored.value.pendingMessageId, turn.pendingMessageId);
          assert.equal(restored.value.requestedAt, turn.requestedAt);
        }
        yield* repository.replacePendingTurnStart({
          threadId,
          messageId: MessageId.makeUnsafe("legacy-prompt"),
          requestedAt: "2026-10-02T00:00:00.000Z",
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
        });
        const legacy = yield* repository.getPendingTurnStartByThreadId({ threadId });
        if (Option.isSome(legacy)) assert.isNull(legacy.value.usageAttribution);
      }),
    );
  },
);
