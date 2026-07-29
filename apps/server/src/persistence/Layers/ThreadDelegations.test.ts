import { MessageId, ProjectId, ThreadId, TurnId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ThreadDelegationRepository } from "../Services/ThreadDelegations.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ThreadDelegationRepositoryLive } from "./ThreadDelegations.ts";

const layer = it.layer(
  ThreadDelegationRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const reservation = {
  delegationId: "delegation-1",
  callerThreadId: ThreadId.makeUnsafe("caller-thread-1"),
  sourceMessageId: MessageId.makeUnsafe("message-1"),
  invocationId: "invocation-1",
  parentDelegationId: null,
  rootDelegationId: "delegation-1",
  depth: 0,
  targetKind: "project",
  targetProjectId: ProjectId.makeUnsafe("target-project-1"),
  targetCanonicalWorkspace: "/workspace/target",
  childThreadId: ThreadId.makeUnsafe("child-thread-1"),
  childTurnId: TurnId.makeUnsafe("child-turn-1"),
  createdProjectId: null,
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
};

layer("ThreadDelegationRepository", (it) => {
  it.effect("reserves idempotently and persists delegation progress", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadDelegationRepository;
      const created = yield* repository.reserve(reservation);
      const existing = yield* repository.reserve({
        ...reservation,
        delegationId: "delegation-ignored",
        childThreadId: ThreadId.makeUnsafe("child-thread-ignored"),
      });
      assert.equal(created.state, "reserved");
      assert.equal(existing.delegationId, reservation.delegationId);
      assert.equal(existing.childThreadId, reservation.childThreadId);

      yield* repository.updateState({
        delegationId: reservation.delegationId,
        state: "turn_accepted",
        updatedAt: "2026-07-29T00:00:01.000Z",
      });
      yield* repository.storeResult({
        delegationId: reservation.delegationId,
        resultJson: '{"accepted":true}',
        errorJson: null,
        updatedAt: "2026-07-29T00:00:02.000Z",
      });

      const byInvocation = yield* repository.getByInvocation({
        callerThreadId: reservation.callerThreadId,
        sourceMessageId: reservation.sourceMessageId,
        invocationId: reservation.invocationId,
      });
      const byChild = yield* repository.findDirectByChild({
        childThreadId: reservation.childThreadId,
      });
      assert.equal(byInvocation._tag, "Some");
      assert.equal(byChild._tag, "Some");
      if (byInvocation._tag === "Some") {
        assert.equal(byInvocation.value.state, "turn_accepted");
        assert.equal(byInvocation.value.resultJson, '{"accepted":true}');
      }
    }),
  );
});
