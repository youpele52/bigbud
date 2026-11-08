import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { makeProjectionPipelinePrefixedTestLayer } from "../../orchestration/Layers/ProjectionPipeline.test.helpers.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import migration from "./157_ProjectionTurnUsageAttribution.ts";
import {
  type AppendInput,
  backfilled,
  forgetUsage,
  legacyRequest,
  legacyTurn,
  legacyTurnRun,
  liveDigest,
  readBaselines,
  readTurns,
  setupEvents,
} from "./157_ProjectionTurnUsageAttribution.test.helpers.ts";

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("bigbud-157-usage-replay-test-")))(
  "migration 157 without a verified baseline",
  (it) => {
    it.effect("backfills legacy turns exactly as a replay from sequence 0 attributes them", () =>
      Effect.gen(function* () {
        const pipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const appendAndProject = (input: AppendInput) =>
          eventStore.append(input).pipe(Effect.flatMap((saved) => pipeline.projectEvent(saved)));

        const events = [
          ...setupEvents(),
          ...legacyTurn(1, "first-model"),
          // An identical duplicate request recovers the same usage whichever one starts the turn.
          legacyRequest(2, "duplicate-model"),
          legacyRequest(2, "duplicate-model"),
          ...legacyTurnRun(2),
          // No `interactionMode`: replay decodes the default, so the backfill must too.
          legacyRequest(3, "default-mode-model", {}),
          ...legacyTurnRun(3),
          // A removed provider: replay keeps the raw payload, so the mode stays missing.
          legacyRequest(4, "retired-model", {
            modelSelection: { provider: "retired", model: "x" },
          }),
          ...legacyTurnRun(4),
          // Still pending: no turn id yet.
          legacyRequest(5, "pending-model"),
        ];
        for (const input of events) yield* appendAndProject(input);
        // A projection from before this change: legacy turns carry no usage.
        yield* forgetUsage;
        assert.ok((yield* readTurns).every((turn) => turn.provider === null));

        yield* migration;
        const expected = [
          backfilled(null, "pending-model"),
          backfilled("legacy-turn-1", "first-model"),
          backfilled("legacy-turn-2", "duplicate-model"),
          backfilled("legacy-turn-3", "default-mode-model", "default"),
          { turnId: "legacy-turn-4", provider: "retired", model: "x", mode: null, source: null },
        ];
        assert.deepEqual(yield* readTurns, expected);

        // No verified baseline: the candidate captured from the backfilled state is verified by
        // replaying every event from sequence 0 through the projector.
        assert.deepEqual(yield* readBaselines, []);
        yield* pipeline.ensureVerifiedBaselineThrough(events.length);
        const verified = yield* readBaselines;
        assert.deepEqual(
          verified.map(({ sequence, status }) => ({ sequence, status })),
          [{ sequence: events.length, status: "verified" }],
        );
        assert.equal(verified[0]?.hash, yield* liveDigest);

        // The pending legacy turn starts after the migration and keeps its backfilled usage.
        for (const input of legacyTurnRun(5)) yield* appendAndProject(input);
        assert.deepEqual(yield* readTurns, [
          ...expected.slice(1),
          backfilled("legacy-turn-5", "pending-model"),
        ]);
      }),
    );
  },
);
