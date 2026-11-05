import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { insertProjectionThreadParent } from "./ProjectionThread.test.helpers.ts";
import { makeListIdleThreadCandidates } from "./ProjectionThreads.idle.ts";
import { makeIdleSweepPaging } from "../../orchestration/Layers/ThreadOrganizationReactor.idle.paging.ts";

const OLD = "2026-10-01T00:00:00.000Z";
const LATER = "2026-10-02T00:00:00.000Z";
const layer = it.layer(SqlitePersistenceMemory);
layer("bounded idle keyset paging", (it) => {
  it.effect(
    "passes >200 protected tied rows in bounded pages and wraps without losing exclusions",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (let index = 0; index < 252; index++) {
          yield* insertProjectionThreadParent({
            sql,
            threadId: ThreadId.makeUnsafe(`paging-${String(index).padStart(3, "0")}`),
            createdAt: OLD,
          });
        }
        // The effective anchor is organization time when that is later than conversation activity.
        yield* sql`UPDATE projection_threads SET organization_changed_at = ${LATER} WHERE thread_id = ${"paging-251"}`;
        const list = makeListIdleThreadCandidates(sql);
        const paging = makeIdleSweepPaging();
        const seen: string[] = [];
        const sizes: number[] = [];
        for (let tick = 0; tick < 6; tick++) {
          const after = paging.after("idle");
          const page = yield* list({
            states: ["present"],
            cutoff: LATER,
            limit: 50,
            ...(after ? { after } : {}),
            excludeThreadIds: [ThreadId.makeUnsafe("paging-250")],
          });
          sizes.push(page.length);
          seen.push(...page.map((entry) => entry.threadId));
          paging.advance("idle", page, 50);
        }
        assert.deepEqual(sizes, [50, 50, 50, 50, 50, 1]);
        assert.equal(new Set(seen).size, 251);
        assert.equal(seen.at(-1), "paging-251");
        assert.isUndefined(paging.after("idle"));
        const last = { activityAt: LATER, threadId: ThreadId.makeUnsafe("paging-251") };
        assert.deepEqual(
          yield* list({ states: ["present"], cutoff: LATER, limit: 50, after: last }),
          [],
        );
        // Equality excludes the cursor itself; tie-breaking by thread ID never loses the next row.
        const tied = yield* list({
          states: ["present"],
          cutoff: OLD,
          limit: 1,
          after: { activityAt: OLD, threadId: ThreadId.makeUnsafe("paging-049") },
        });
        assert.equal(tied[0]?.threadId, "paging-050");
      }),
  );
});
