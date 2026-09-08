import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, Fiber, Layer, Metric, Option, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";

const writeStartupStatus = vi.hoisted(() => vi.fn());
vi.mock("./startupStatus.ts", () => ({ writeStartupStatus }));

import { Keybindings } from "../keybindings/keybindings.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationReactor } from "../orchestration/Services/OrchestrationReactor.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import { Open } from "../utils/open.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerLifecycleEvents, ServerLifecycleEventsLive } from "./serverLifecycleEvents.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../orchestration/Services/ProjectionPipeline.ts";
import { ServerConfig } from "./config.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import {
  launchStartupHeartbeat,
  makeCommandGate,
  ServerRuntimeStartupError,
  ServerRuntimeStartup,
  ServerRuntimeStartupLive,
} from "./serverRuntimeStartup.ts";
import { runStartupPhase } from "./serverRuntimeStartup.browser.ts";
import { ThreadRetention } from "../retention/Services/ThreadRetention.ts";
import { EntityPurgeTest } from "../deletion/Services/EntityPurge.ts";

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

const startupLayer = (
  events: Array<string>,
  projectionPipeline: OrchestrationProjectionPipelineShape = {
    bootstrap: Effect.void,
    backfillUsageContributions: Effect.void,
    ensureVerifiedBaselineThrough: () => Effect.void,
    compactVerifiedPrefix: () => Effect.void,
    projectEvent: () => Effect.void,
  },
  reactorStart: Effect.Effect<void> = Effect.sync(() => events.push("reactors.start")),
  retentionStart?: Effect.Effect<void>,
  analyticsRecord: (name: string) => Effect.Effect<void> = () => Effect.void,
) => {
  const nodeServices = NodeServices.layer;
  const serverConfig = ServerConfig.layerTest(process.cwd(), {
    prefix: "bigbud-startup-order-",
  }).pipe(Layer.provide(nodeServices));

  return ServerRuntimeStartupLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        nodeServices,
        serverConfig,
        EntityPurgeTest,
        ServerLifecycleEventsLive,
        ServerSettingsService.layerTest(),
        Layer.succeed(AnalyticsService, {
          record: analyticsRecord,
          flush: Effect.void,
        }),
        Layer.succeed(OrchestrationProjectionPipeline, projectionPipeline),
        Layer.succeed(Keybindings, {
          start: Effect.void,
          ready: Effect.void,
          syncDefaultKeybindingsOnStartup: Effect.void,
          loadConfigState: Effect.die("keybindings loadConfigState"),
          getSnapshot: Effect.die("keybindings getSnapshot"),
          streamChanges: Stream.empty,
          upsertKeybindingRule: () => Effect.die("keybindings upsertKeybindingRule"),
        }),
        Layer.succeed(OrchestrationReactor, {
          start: () => reactorStart,
        }),
        Layer.succeed(OrchestrationEngineService, {
          getReadModel: () => Effect.succeed({ projects: [] } as never),
          readEvents: () => Stream.empty,
          readReplay: () => Effect.die("engine readReplay"),
          dispatch: () => Effect.succeed({ sequence: 1 }),
          streamDomainEvents: Stream.empty,
        }),
        Layer.succeed(ProjectionSnapshotQuery, {
          getSnapshot: () => Effect.die("projection getSnapshot"),
          getCounts: () => Effect.die("projection getCounts"),
          getUsageEntries: () => Effect.die("projection getUsageEntries"),
          getUsageHistoryStatus: () => Effect.die("projection getUsageHistoryStatus"),
          getActiveProjectByWorkspaceRoot: () =>
            Effect.die("projection getActiveProjectByWorkspaceRoot"),
          getFirstActiveThreadIdByProjectId: () =>
            Effect.die("projection getFirstActiveThreadIdByProjectId"),
          getThreadCheckpointContext: () => Effect.die("projection getThreadCheckpointContext"),
        }),
        Layer.succeed(ProviderRegistry, {
          getProviders: Effect.succeed([]),
          refresh: () => Effect.succeed([]),
          streamChanges: Stream.empty,
          awaitFirstReadyProvider: Effect.succeed(Option.none()),
        }),
        Layer.succeed(Open, {
          openBrowser: () => Effect.void,
          openInEditor: () => Effect.void,
          openInTerminal: () => Effect.void,
          openPath: () => Effect.void,
        }),
        ...(retentionStart
          ? [
              Layer.mock(ThreadRetention)({
                start: retentionStart,
              }),
            ]
          : []),
      ),
    ),
  );
};

it.effect("enqueueCommand waits for readiness and then drains queued work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executionCount = yield* Ref.make(0);
      const commandGate = yield* makeCommandGate();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Ref.updateAndGet(executionCount, (count) => count + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(executionCount), 0);

      yield* commandGate.signalCommandReady;

      const result = yield* Fiber.join(queuedCommandFiber);
      assert.equal(result, 1);
      assert.equal(yield* Ref.get(executionCount), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* makeCommandGate();
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartupError({
          message: "startup failed",
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "startup failed");
    }),
  ),
);

it.effect("launchStartupHeartbeat does not block the caller while counts are loading", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releaseCounts = yield* Deferred.make<void, never>();

      yield* launchStartupHeartbeat.pipe(
        Effect.provideService(ProjectionSnapshotQuery, {
          getSnapshot: () => Effect.die("unused"),
          getCounts: () =>
            Deferred.await(releaseCounts).pipe(
              Effect.as({
                projectCount: 2,
                threadCount: 3,
              }),
            ),
          getUsageEntries: () => Effect.succeed([]),
          getUsageHistoryStatus: () => Effect.succeed("ready"),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        }),
        Effect.provideService(AnalyticsService, {
          record: () => Effect.void,
          flush: Effect.void,
        }),
      );
    }),
  ),
);

it.effect("runStartupPhase records duration and outcome metrics", () =>
  Effect.gen(function* () {
    yield* runStartupPhase("test.phase", Effect.void);

    const snapshots = yield* Metric.snapshot;
    assert.isTrue(
      hasMetricSnapshot(snapshots, "t3_server_startup_phases_total", {
        phase: "test.phase",
        outcome: "success",
      }),
    );
    assert.isTrue(
      hasMetricSnapshot(snapshots, "t3_server_startup_phase_duration", {
        phase: "test.phase",
      }),
    );
  }),
);

it.effect("does not schedule the retired purge audit", () => {
  const events: Array<string> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const startup = yield* ServerRuntimeStartup;

      yield* startup.awaitCommandReady;
      yield* Effect.yieldNow;
      assert.deepEqual(events, ["reactors.start"]);

      yield* startup.markHttpListening;
      yield* Effect.yieldNow;
      assert.deepEqual(events, ["reactors.start"]);

      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      assert.deepEqual(events, ["reactors.start"]);
    }).pipe(Effect.provide(startupLayer(events))),
  );
});

it.effect("starts the heartbeat before thread retention", () => {
  const events: Array<string> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const startup = yield* ServerRuntimeStartup;
      const lifecycleEvents = yield* ServerLifecycleEvents;
      const readyEvent = yield* lifecycleEvents.stream.pipe(
        Stream.filter((event) => event.type === "ready"),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* startup.awaitCommandReady;
      yield* startup.markHttpListening;
      yield* Fiber.join(readyEvent);
      for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;
      assert.isBelow(events.indexOf("heartbeat"), events.indexOf("retention.start"));
    }).pipe(
      Effect.provide(
        startupLayer(
          events,
          undefined,
          undefined,
          Effect.sync(() => events.push("retention.start")),
          (name) =>
            Effect.sync(() => events.push(name === "server.boot.heartbeat" ? "heartbeat" : name)),
        ),
      ),
    ),
  );
});

it.effect("does not compact canonical events during startup", () => {
  const events: Array<string> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const startup = yield* ServerRuntimeStartup;
      const lifecycleEvents = yield* ServerLifecycleEvents;
      const readyEvent = yield* lifecycleEvents.stream.pipe(
        Stream.filter((event) => event.type === "ready"),
        Stream.runHead,
        Effect.forkScoped,
      );

      yield* startup.awaitCommandReady;
      yield* Effect.yieldNow;
      assert.notInclude(events, "compaction.start");

      yield* startup.markHttpListening;

      const ready = yield* Fiber.join(readyEvent);
      assert.isTrue(Option.isSome(ready));
      yield* TestClock.adjust("2 seconds");
      assert.notInclude(events, "compaction.start");
    }).pipe(
      Effect.provide(
        startupLayer(events, {
          bootstrap: Effect.void,
          backfillUsageContributions: Effect.void,
          ensureVerifiedBaselineThrough: () => Effect.sync(() => events.push("compaction.start")),
          compactVerifiedPrefix: () => Effect.sync(() => events.push("compaction.start")),
          projectEvent: () => Effect.void,
        }),
      ),
    ),
  );
});

it.effect("reports asynchronous runtime startup failures to the desktop status pipe", () =>
  Effect.scoped(
    Effect.gen(function* () {
      writeStartupStatus.mockClear();
      const startup = yield* ServerRuntimeStartup;
      yield* Effect.flip(startup.awaitCommandReady);
      assert.deepEqual(writeStartupStatus.mock.calls, [["error", "server_runtime_startup_failed"]]);
    }).pipe(Effect.provide(startupLayer([], undefined, Effect.die("reactor failed")))),
  ),
);
