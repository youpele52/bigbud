import {
  DATABASE_COMPACTION_WS_METHODS,
  type ServerDatabaseCompactionError,
} from "@bigbud/contracts/server/databaseCompaction.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import {
  DatabaseCompaction,
  type DatabaseCompactionShape,
} from "../persistence/Services/DatabaseCompaction.ts";
import { makeWsRpcDatabaseCompactionHandlers } from "./wsRpcHandlers.databaseCompaction.ts";

const status = {
  state: "idle" as const,
  phase: null,
  startedAt: null,
  estimatedDurationMs: null,
  lastRun: null,
};

it.effect("reports compaction as unavailable when the server runs without the service", () =>
  Effect.gen(function* () {
    const handlers = yield* makeWsRpcDatabaseCompactionHandlers;
    const calls: ReadonlyArray<() => Effect.Effect<unknown, ServerDatabaseCompactionError>> = [
      handlers[DATABASE_COMPACTION_WS_METHODS.getStatus],
      handlers[DATABASE_COMPACTION_WS_METHODS.preview],
      handlers[DATABASE_COMPACTION_WS_METHODS.start],
    ];
    for (const call of calls) {
      const exit = yield* Effect.exit(call());
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const reason = exit.cause.reasons[0];
        assert.equal(reason?._tag === "Fail" ? reason.error.code : null, "unavailable");
      }
    }
  }),
);

it.effect("delegates status, preview and start to the service", () =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const service: DatabaseCompactionShape = {
      status: Effect.sync(() => {
        calls.push("status");
        return status;
      }),
      preview: Effect.die("not used"),
      start: Effect.sync(() => {
        calls.push("start");
        return { ...status, state: "running" as const, phase: "preparing" as const };
      }),
      runSteadyStateStep: () => Effect.die("not used"),
    };
    const handlers = yield* makeWsRpcDatabaseCompactionHandlers.pipe(
      Effect.provideService(DatabaseCompaction, service),
    );
    assert.deepEqual(yield* handlers[DATABASE_COMPACTION_WS_METHODS.getStatus](), status);
    assert.equal((yield* handlers[DATABASE_COMPACTION_WS_METHODS.start]()).state, "running");
    assert.deepEqual(calls, ["status", "start"]);
  }),
);
