import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { insertProjectionThreadParent } from "../Layers/ProjectionThread.test.helpers.ts";
import { canonicalUsage } from "../../provider/Layers/ProviderUsageAccounting.canonical.ts";
import { decodeCodexState } from "../Layers/ProjectionUsageCodex.state.ts";
import { reduceCodexUsage } from "../Layers/ProjectionUsageCodex.reducer.ts";

it.effect("upgrades old lowered checkpoints and retirement arrays without enabling recount", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 133 });
    const threadId = ThreadId.makeUnsafe("old-codex-state");
    yield* insertProjectionThreadParent({ sql, threadId });
    const counter = (value: number) =>
      canonicalUsage({
        basis: "fixture",
        inputTokens: value,
        outputTokens: 0,
        reportedTotal: value,
      })!;
    const old = {
      nativeThreadId: "native",
      turnId: "turn",
      total: counter(110),
      amount: counter(30),
      fingerprints: [JSON.stringify(["native", counter(120), counter(20)])],
      retired: ["old", "older", "old"],
    };
    yield* sql`INSERT INTO projection_usage_codex_state VALUES (${threadId}, ${JSON.stringify(old)})`;
    yield* runMigrations();
    const [row] = yield* sql<{
      state_json: string;
    }>`SELECT state_json FROM projection_usage_codex_state WHERE thread_id = ${threadId}`;
    const decoded = decodeCodexState(row!.state_json);
    assert.isFalse(decoded.upgraded);
    assert.equal(decoded.state.total.subtotal, 120);
    assert.equal(
      reduceCodexUsage(decoded.state, "turn", {
        nativeThreadId: "native",
        total: counter(130),
        last: counter(10),
      })?.amount.subtotal,
      40,
    );
    const retired = yield* sql<{
      turn_id: string;
    }>`SELECT turn_id FROM projection_usage_codex_retired_turns WHERE thread_id = ${threadId} ORDER BY turn_id`;
    assert.deepEqual(
      retired.map((row) => row.turn_id),
      ["old", "older"],
    );
    assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
