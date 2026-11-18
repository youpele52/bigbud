import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { legacyMetadataEvidenceQuery } from "./ThreadMetadataGeneration.legacy.ts";

it.layer(SqlitePersistenceMemory)("legacy metadata evidence query plan", (it) => {
  it.effect("uses indexed identity lookups within correlated history checks", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [statement, parameters] = legacyMetadataEvidenceQuery(sql, {
        threadId: ThreadId.makeUnsafe("query-plan"),
      }).compile();
      const plan = yield* sql.unsafe<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${statement}`,
        parameters,
      );
      const identities = plan.filter((row) =>
        row.detail.includes("idx_orch_events_thread_activity_identity"),
      );
      assert.strictEqual(identities.length, 3, JSON.stringify(plan));
      assert.isTrue(
        identities.every((row) => row.detail.includes("<expr>=?")),
        JSON.stringify(plan),
      );
      assert.strictEqual(
        plan.filter((row) =>
          /SEARCH a USING INDEX idx_projection_thread_activities_thread/.test(row.detail),
        ).length,
        1,
        JSON.stringify(plan),
      );
      assert.isFalse(
        plan.some((row) => /SCAN (request|a|e)(?: |$)/.test(row.detail)),
        JSON.stringify(plan),
      );
    }),
  );
});
