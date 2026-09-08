import { ThreadId, TurnId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ProviderTurnLivenessRepository } from "../Services/ProviderTurnLiveness.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProviderTurnLivenessRepositoryLive } from "./ProviderTurnLiveness.ts";
import { insertProjectionThreadParent } from "./ProjectionThread.test.helpers.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const layer = ProviderTurnLivenessRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const threadId = ThreadId.makeUnsafe("persisted-liveness-thread");
const turnId = TurnId.makeUnsafe("persisted-liveness-turn");
const startedAt = "2026-08-13T00:00:00.000Z";
const sessionEpoch = 0;

it.layer(layer)("provider turn liveness repository", (it) => {
  it.effect("persists active liveness and meaningful progress across reads", () =>
    Effect.gen(function* () {
      yield* insertProjectionThreadParent({
        sql: yield* SqlClient.SqlClient,
        threadId,
      });
      const repository = yield* ProviderTurnLivenessRepository;
      yield* repository.startTurn({ threadId, turnId, provider: "codex", sessionEpoch, startedAt });
      const progressAt = "2026-08-13T00:01:00.000Z";
      yield* repository.observeEvent(
        {
          type: "content.delta",
          eventId: "progress" as never,
          provider: "codex",
          sessionEpoch,
          threadId,
          turnId,
          createdAt: progressAt,
          payload: { streamKind: "assistant_text", delta: "progress" },
        },
        true,
      );
      assert.deepEqual(yield* repository.listActive(), [
        {
          threadId,
          turnId,
          provider: "codex",
          sessionEpoch,
          turnStartedAt: startedAt,
          lastRuntimeEventAt: progressAt,
          lastMeaningfulProgressAt: progressAt,
          lastInspectionAt: null,
          inspectionStatus: "idle",
          consecutiveInspectionFailures: 0,
          terminalAt: null,
        },
      ]);
    }),
  );

  it.effect("settles exactly once and cannot be resurrected by a late start write", () =>
    Effect.gen(function* () {
      yield* insertProjectionThreadParent({
        sql: yield* SqlClient.SqlClient,
        threadId,
      });
      const repository = yield* ProviderTurnLivenessRepository;
      assert.isTrue(
        yield* repository.claimTerminal({
          threadId,
          turnId,
          provider: "codex",
          sessionEpoch,
          terminalAt: startedAt,
        }),
      );
      assert.isFalse(
        yield* repository.claimTerminal({
          threadId,
          turnId,
          provider: "codex",
          sessionEpoch,
          terminalAt: startedAt,
        }),
      );
      yield* repository.startTurn({ threadId, turnId, provider: "codex", sessionEpoch, startedAt });
      assert.deepEqual(yield* repository.listActive(), []);
    }),
  );

  it.effect("does not change the failure streak for checking or unavailable inspections", () =>
    Effect.gen(function* () {
      yield* insertProjectionThreadParent({
        sql: yield* SqlClient.SqlClient,
        threadId: ThreadId.makeUnsafe("checking-liveness-thread"),
      });
      const repository = yield* ProviderTurnLivenessRepository;
      const checkingThreadId = ThreadId.makeUnsafe("checking-liveness-thread");
      const checkingTurnId = TurnId.makeUnsafe("checking-liveness-turn");
      yield* repository.startTurn({
        threadId: checkingThreadId,
        turnId: checkingTurnId,
        provider: "codex",
        sessionEpoch,
        startedAt,
      });
      yield* repository.recordInspection({
        threadId: checkingThreadId,
        turnId: checkingTurnId,
        sessionEpoch,
        observedAt: startedAt,
        status: "timed-out",
        failed: true,
      });
      yield* repository.recordInspection({
        threadId: checkingThreadId,
        turnId: checkingTurnId,
        sessionEpoch,
        observedAt: "2026-08-13T00:01:00.000Z",
        status: "checking",
        failed: false,
      });
      yield* repository.recordInspection({
        threadId: checkingThreadId,
        turnId: checkingTurnId,
        sessionEpoch,
        observedAt: "2026-08-13T00:02:00.000Z",
        status: "unavailable",
        failed: false,
      });

      assert.strictEqual((yield* repository.listActive())[0]?.consecutiveInspectionFailures, 1);
    }),
  );
});
