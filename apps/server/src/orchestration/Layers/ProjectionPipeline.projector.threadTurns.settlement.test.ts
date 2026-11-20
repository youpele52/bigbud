import { ThreadId, TurnId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { insertProjectionThreadParent } from "../../persistence/Layers/ProjectionThread.test.helpers.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { makeEvent } from "../projector.test.helpers.ts";
import { makeThreadTurnsProjector } from "./ProjectionPipeline.projector.threadTurns.ts";

const now = "2026-11-11T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("native-settlement");
const turnId = TurnId.makeUnsafe("native-turn");
it.layer(ProjectionTurnRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "turn settlement persistence",
  (it) => {
    it.effect(
      "keeps final messages and checkpoints nonterminal, persists native proof across late checkpoint and interrupt",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* insertProjectionThreadParent({ sql, threadId });
          const repository = yield* ProjectionTurnRepository;
          const projector = makeThreadTurnsProjector({ projectionTurnRepository: repository });
          let sequence = 0;
          const apply = (type: Parameters<typeof makeEvent>[0]["type"], payload: unknown) =>
            projector.apply(
              makeEvent({
                sequence: ++sequence,
                type,
                aggregateKind: "thread",
                aggregateId: threadId,
                occurredAt: now,
                commandId: "settle",
                payload,
              }),
              { prunedThreadRelativePaths: new Map() },
            );
          const read = () =>
            repository.getByTurnId({ threadId, turnId }).pipe(Effect.map(Option.getOrThrow));
          yield* apply("thread.message-sent", {
            threadId,
            turnId,
            messageId: "message",
            role: "assistant",
            text: "Done",
            streaming: false,
            createdAt: now,
            updatedAt: now,
          });
          yield* apply("thread.turn-diff-completed", {
            threadId,
            turnId,
            assistantMessageId: "message",
            checkpointTurnCount: 1,
            checkpointRef: "refs/checkpoint/1",
            status: "ready",
            files: [],
            completedAt: now,
          });
          const checkpoint = yield* read();
          assert.equal(checkpoint.state, "running");
          assert.equal(checkpoint.completedAt, null);
          assert.equal(checkpoint.terminalOutcome, null);
          assert.equal(checkpoint.checkpointCompletedAt, now);
          yield* apply("thread.turn-settled", {
            threadId,
            turnId,
            outcome: "completed",
            sessionEpoch: 0,
            completedAt: now,
          });
          yield* apply("thread.turn-interrupt-requested", { threadId, turnId, createdAt: now });
          yield* apply("thread.turn-settled", {
            threadId,
            turnId,
            outcome: "failed",
            sessionEpoch: 0,
            completedAt: now,
          });
          const completed = yield* read();
          assert.equal(completed.terminalOutcome, "completed");
          assert.equal(completed.state, "completed");
          assert.equal(completed.completedAt, now);
          assert.equal(completed.checkpointCompletedAt, now);
          yield* apply("thread.reverted", { threadId, turnCount: 1 });
          assert.equal((yield* read()).terminalOutcome, "completed");
          assert.equal((yield* read()).checkpointCompletedAt, now);
        }),
    );
  },
);
