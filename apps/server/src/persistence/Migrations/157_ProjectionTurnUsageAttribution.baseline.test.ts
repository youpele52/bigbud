import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeProjectionPipelinePrefixedTestLayer } from "../../orchestration/Layers/ProjectionPipeline.test.helpers.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { insertCapturedBaseline } from "../Layers/ProjectionBaselines.test.helpers.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import migration from "./157_ProjectionTurnUsageAttribution.ts";
import {
  type AppendInput,
  at,
  backfilled,
  event,
  forgetUsage,
  legacyRequest,
  legacyTurn,
  legacyTurnRun,
  liveDigest,
  readBaselines,
  readTurns,
  setupEvents,
  threadId,
} from "./157_ProjectionTurnUsageAttribution.test.helpers.ts";

/** The stored turn row of `turnId` (NULL: the pending start) in a baseline. */
const readBaselineTurn = (baselineId: number, turnId: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly source: string | null }>`
      SELECT json_extract(row_json, '$.usage_attribution_source') AS source
      FROM projection_baseline_rows
      WHERE baseline_id = ${baselineId} AND table_name = 'projection_turns'
        AND json_extract(row_json, '$.turn_id') IS ${turnId}
    `;
    return rows;
  });

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("bigbud-157-usage-baseline-test-")))(
  "migration 157 and projection baselines",
  (it) => {
    it.effect(
      "keeps a pre-157 verified baseline replayable, so new baselines verify and the floor advances",
      () =>
        Effect.gen(function* () {
          const pipeline = yield* OrchestrationProjectionPipeline;
          const eventStore = yield* OrchestrationEventStore;
          const sql = yield* SqlClient.SqlClient;
          const appendAndProject = (input: AppendInput) =>
            eventStore.append(input).pipe(Effect.flatMap((saved) => pipeline.projectEvent(saved)));

          // Turn 3 is still pending when the baseline is captured, and starts after it.
          const setup = [
            ...setupEvents(),
            ...legacyTurn(1, "kept-model"),
            ...legacyTurn(2, "reverted-model"),
            legacyRequest(3, "pending-model"),
          ];
          for (const input of setup) yield* appendAndProject(input);
          // A projection and baseline from before this change: legacy turns carry no usage.
          yield* forgetUsage;
          const baseline = yield* insertCapturedBaseline({
            sequence: setup.length,
            status: "verified",
            createdAt: at(35),
          });
          const [preMigration] = yield* readBaselines;
          assert.equal(preMigration?.status, "verified");
          assert.equal(preMigration?.hash, yield* liveDigest);
          for (const input of legacyTurnRun(3)) yield* appendAndProject(input);
          yield* forgetUsage;
          assert.ok((yield* readTurns).every((turn) => turn.provider === null));

          // Migrations run before event-log maintenance, so the request events still exist.
          yield* migration;
          assert.deepEqual(yield* readTurns, [
            backfilled("legacy-turn-1", "kept-model"),
            backfilled("legacy-turn-2", "reverted-model"),
            backfilled("legacy-turn-3", "pending-model"),
          ]);
          // The stored baseline is patched where a replay would attribute it, including the
          // turn that is still pending there although it has since started live.
          const [patched] = yield* readBaselines;
          assert.equal(patched?.sequence, setup.length);
          assert.notEqual(patched?.hash, preMigration?.hash);
          assert.deepEqual(yield* readBaselineTurn(baseline.baselineId, null), [
            { source: "backfill" },
          ]);
          assert.deepEqual(yield* readBaselineTurn(baseline.baselineId, "legacy-turn-1"), [
            { source: "backfill" },
          ]);

          // A replay from the pre-157 baseline reproduces the live state: the hash matches.
          yield* appendAndProject(
            event("thread.meta-updated", { threadId, title: "Renamed", updatedAt: at(40) }, 40),
          );
          const latest = setup.length + 3;
          yield* pipeline.ensureVerifiedBaselineThrough(latest);
          const verified = yield* readBaselines;
          assert.deepEqual(
            verified.map(({ sequence, status }) => ({ sequence, status })),
            [{ sequence: latest, status: "verified" }],
          );
          assert.equal(verified[0]?.hash, yield* liveDigest);

          // The cleanup floor follows the new verified baseline.
          yield* pipeline.compactVerifiedPrefix(100);
          const replay = yield* eventStore.readReplay(0);
          assert.equal(replay.availability, "gap");
          assert.equal(replay.retainedFromSequenceExclusive, latest);
          const remaining = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS "count" FROM orchestration_events WHERE sequence <= ${latest}
          `;
          assert.equal(remaining[0]?.count, 0);

          // Reverting keeps the backfilled attribution of the kept turn, after its request is gone.
          yield* appendAndProject(event("thread.reverted", { threadId, turnCount: 1 }, 50));
          assert.deepEqual(yield* readTurns, [backfilled("legacy-turn-1", "kept-model")]);
        }),
    );
  },
);
