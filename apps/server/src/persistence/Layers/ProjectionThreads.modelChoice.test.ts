import { EventId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { insertProjectionThreadParent } from "./ProjectionThread.test.helpers.ts";

const layer = it.layer(
  Layer.mergeAll(ProjectionThreadActivityRepositoryLive, ProjectionThreadRepositoryLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const setThread = (
  sql: SqlClient.SqlClient,
  threadId: string,
  model: object,
  lastActivityAt: string,
  options: { readonly started?: boolean; readonly deleted?: boolean } = {},
) =>
  Effect.gen(function* () {
    yield* insertProjectionThreadParent({ sql, threadId: ThreadId.makeUnsafe(threadId) });
    yield* sql`
      UPDATE projection_threads SET
        model_selection_json = ${JSON.stringify(model)},
        last_activity_at = ${lastActivityAt},
        latest_turn_id = ${options.started === false ? null : `turn-${threadId}`},
        deleted_at = ${options.deleted ? lastActivityAt : null}
      WHERE thread_id = ${threadId}
    `;
  });

layer("delegated model choice persistence reads", (it) => {
  it.effect("lists recently used models newest first, deduplicated, started threads only", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectionThreadRepository;
      yield* setThread(sql, "a", { provider: "codex", model: "gpt-5" }, "2026-10-15T08:00:00.000Z");
      yield* setThread(sql, "b", { provider: "codex", model: "gpt-5" }, "2026-10-15T09:00:00.000Z");
      yield* setThread(
        sql,
        "c",
        { provider: "pi", model: "m", subProviderID: "openai" },
        "2026-10-15T08:30:00.000Z",
      );
      yield* setThread(sql, "d", { provider: "copilot", model: "x" }, "2026-10-15T10:00:00.000Z", {
        started: false,
      });
      yield* setThread(sql, "e", { provider: "cursor", model: "y" }, "2026-10-15T11:00:00.000Z", {
        deleted: true,
      });
      const recent = yield* repository.listRecentModelSelections({ limit: 10 });
      assert.deepStrictEqual(recent, [
        { provider: "codex", model: "gpt-5", lastUsedAt: "2026-10-15T09:00:00.000Z" },
        {
          provider: "pi",
          model: "m",
          subProviderID: "openai",
          lastUsedAt: "2026-10-15T08:30:00.000Z",
        },
      ]);
      assert.lengthOf(yield* repository.listRecentModelSelections({ limit: 1 }), 1);
    }),
  );

  it.effect("lists only unresolved model-choice requests on live threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const activities = yield* ProjectionThreadActivityRepository;
      const add = (threadId: string, id: string, kind: string, choiceId: string) =>
        activities.upsert({
          activityId: EventId.makeUnsafe(id),
          threadId: ThreadId.makeUnsafe(threadId),
          turnId: null,
          tone: "info",
          kind,
          summary: kind,
          payload: { choiceId },
          createdAt: "2026-10-15T10:00:00.000Z",
        });
      for (const threadId of ["held", "done", "gone"]) {
        yield* setThread(
          sql,
          threadId,
          { provider: "codex", model: "m" },
          "2026-10-15T10:00:00.000Z",
        );
      }
      yield* add("held", "r1", "delegation.model-choice-requested", "c1");
      yield* add("done", "r2", "delegation.model-choice-requested", "c2");
      yield* add("done", "s2", "delegation.model-choice-resolved", "c2");
      yield* add("gone", "r3", "delegation.model-choice-requested", "c3");
      yield* sql`UPDATE projection_threads SET deleted_at = ${"2026-10-15T10:01:00.000Z"} WHERE thread_id = ${"gone"}`;
      const pending = yield* activities.listPendingDelegatedModelChoiceRequests({ limit: 50 });
      assert.deepStrictEqual(
        pending.map((row) => [row.threadId, (row.payload as { choiceId: string }).choiceId]),
        [["held", "c1"]],
      );
    }),
  );
});
