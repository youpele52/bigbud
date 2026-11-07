import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DESKTOP_SUPERVISOR_REPLAY_BUFFER_CAPACITY } from "../../desktop-supervisor/desktopSupervisorConfig.ts";
import { inspectCompleteReplay } from "../../desktop-supervisor/desktopSupervisorDelivery.session.replay.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { makeEventLogMaintenance } from "./EventLogMaintenance.ts";
import {
  IDLE_SIGNALS,
  NOW_MS,
  readRetention,
  seedCompactableLog,
} from "./EventLogMaintenance.test.helpers.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const TestLayer = OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const HOT_WINDOW = { sequences: 5_000, ms: 60_000 } as const;

it.effect(
  "replay below retained_through reports a gap; the desktop replay budget is unchanged",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const eventStore = yield* OrchestrationEventStore;
      yield* seedCompactableLog(sql, { count: 6_000, receipts: false });
      const maintenance = yield* makeEventLogMaintenance({
        now: () => NOW_MS,
        readSignals: () => Effect.succeed(IDLE_SIGNALS),
        floorInputs: () => ({ reactorCursor: null, deliveryAcknowledged: null }),
        hotWindow: HOT_WINDOW,
      });
      for (let tick = 0; tick < 20; tick += 1) {
        if ((yield* maintenance.service.runTick).drained) break;
      }
      const retained = (yield* readRetention(sql)).retained;
      assert.equal(retained, 1_000);

      // A client behind the compacted prefix gets `gap` with the retained range, which is what
      // sends it to the bounded bootstrap; it never receives a partial history.
      const behind = yield* eventStore.readReplay(500, 1_000);
      assert.equal(behind.availability, "gap");
      assert.equal(behind.retainedFromSequenceExclusive, retained);
      assert.equal(behind.latestSequence, 6_000);
      assert.deepEqual(behind.events, []);
      const services = yield* Effect.services<never>();
      const readReplay = (from: number, limit?: number) =>
        Effect.runPromiseWith(services)(Effect.orDie(eventStore.readReplay(from, limit)));
      const recovering = yield* Effect.promise(() =>
        inspectCompleteReplay({ acknowledgedSequence: 500, readReplay }),
      );
      assert.equal(recovering.recoveryReason, "replay_unavailable");

      // At or above retained_through, replay works exactly as before, within the same budget.
      assert.equal(DESKTOP_SUPERVISOR_REPLAY_BUFFER_CAPACITY, 4_000);
      const caughtUp = yield* Effect.promise(() =>
        inspectCompleteReplay({ acknowledgedSequence: 3_000, readReplay }),
      );
      assert.equal(caughtUp.recoveryReason, undefined);
      assert.equal(caughtUp.replay.events.length, 3_000);
      const overBudget = yield* Effect.promise(() =>
        inspectCompleteReplay({ acknowledgedSequence: retained, readReplay }),
      );
      assert.equal(overBudget.recoveryReason, "replay_budget_exceeded");
    }).pipe(Effect.provide(TestLayer)),
);
