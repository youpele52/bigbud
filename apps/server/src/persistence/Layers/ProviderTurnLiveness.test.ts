import { ThreadId, TurnId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ProviderTurnLivenessRepository } from "../Services/ProviderTurnLiveness.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProviderTurnLivenessRepositoryLive } from "./ProviderTurnLiveness.ts";

const layer = ProviderTurnLivenessRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const threadId = ThreadId.makeUnsafe("persisted-liveness-thread");
const turnId = TurnId.makeUnsafe("persisted-liveness-turn");
const startedAt = "2026-08-13T00:00:00.000Z";

it.layer(layer)("provider turn liveness repository", (it) => {
  it.effect("persists active liveness and meaningful progress across reads", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderTurnLivenessRepository;
      yield* repository.startTurn({ threadId, turnId, provider: "codex", startedAt });
      const progressAt = "2026-08-13T00:01:00.000Z";
      yield* repository.observeEvent(
        {
          type: "content.delta",
          eventId: "progress" as never,
          provider: "codex",
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
      const repository = yield* ProviderTurnLivenessRepository;
      assert.isTrue(
        yield* repository.claimTerminal({
          threadId,
          turnId,
          provider: "codex",
          terminalAt: startedAt,
        }),
      );
      assert.isFalse(
        yield* repository.claimTerminal({
          threadId,
          turnId,
          provider: "codex",
          terminalAt: startedAt,
        }),
      );
      yield* repository.startTurn({ threadId, turnId, provider: "codex", startedAt });
      assert.deepEqual(yield* repository.listActive(), []);
    }),
  );
});
