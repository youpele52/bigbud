import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  resetRetentionTestRows,
  seedRetentionTestThread,
  seedWorktreeLease,
} from "../retention/threadRetention.test.helpers.ts";
import { makeRuntimeUpdateDrainProbe } from "./runtimeUpdate.drain.probe.ts";

const layer = it.layer(SqlitePersistenceMemory);
const at = "2026-01-01T00:00:00.000Z";
const idleEngine = {
  getReadModel: () => Effect.succeed({ threads: [] }),
} as unknown as OrchestrationEngineShape;

layer("runtime update drain probe", (it) => {
  it.effect("an idle or stale provider-session lease is not affected work; a shell is", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* resetRetentionTestRows();
      for (const threadId of ["idle", "shell", "terminal"])
        yield* seedRetentionTestThread(threadId, at);
      yield* seedWorktreeLease({
        leaseId: "provider:idle",
        threadId: "idle",
        kind: "provider",
        expiresAt: null,
      });
      yield* seedWorktreeLease({
        leaseId: "shell:1",
        threadId: "shell",
        kind: "shell",
        expiresAt: null,
      });
      yield* seedWorktreeLease({
        leaseId: "terminal:1",
        threadId: "terminal",
        kind: "terminal",
        expiresAt: null,
      });
      const work = yield* makeRuntimeUpdateDrainProbe({ engine: idleEngine, sql }).affectedWork;
      assert.deepStrictEqual(
        work.map((item) => item.id),
        ["shell#shell"],
      );
    }),
  );
});
