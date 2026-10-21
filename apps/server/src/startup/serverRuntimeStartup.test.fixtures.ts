import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Option, Stream } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { GitCore } from "../git/Services/GitCore.ts";
import { Keybindings } from "../keybindings/keybindings.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationReactor } from "../orchestration/Services/OrchestrationReactor.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../orchestration/Services/ProjectionPipeline.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import { Open } from "../utils/open.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { ThreadRetention } from "../retention/Services/ThreadRetention.ts";
import { EntityPurgeTest } from "../deletion/Services/EntityPurge.ts";
import { ServerConfig } from "./config.ts";
import { ServerLifecycleEventsLive } from "./serverLifecycleEvents.ts";
import { ServerRuntimeStartupLive } from "./serverRuntimeStartup.ts";

/** Exercise runtime startup with disposable configuration and no provider processes. */
export function startupLayer(
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
  workspace: Layer.Layer<SqlClient.SqlClient | GitCore> | Layer.Layer<never> = Layer.empty,
) {
  const nodeServices = NodeServices.layer;
  const serverConfig = ServerConfig.layerTest(process.cwd(), {
    prefix: "bigbud-startup-order-",
  }).pipe(Layer.provide(nodeServices));

  return ServerRuntimeStartupLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        nodeServices,
        serverConfig,
        workspace,
        EntityPurgeTest,
        ServerLifecycleEventsLive,
        ServerSettingsService.layerTest(),
        Layer.succeed(AnalyticsService, { record: analyticsRecord, flush: Effect.void }),
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
        Layer.succeed(OrchestrationReactor, { start: () => reactorStart }),
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
          getUsageActiveDays: () => Effect.die("projection getUsageActiveDays"),
          getActiveProjectByWorkspaceRoot: () =>
            Effect.die("projection getActiveProjectByWorkspaceRoot"),
          getFirstActiveThreadIdByProjectId: () =>
            Effect.die("projection getFirstActiveThreadIdByProjectId"),
          getThreadCheckpointContext: () => Effect.die("projection getThreadCheckpointContext"),
        }),
        Layer.succeed(ProviderRegistry, {
          getProviders: Effect.succeed([]),
          refresh: () => Effect.succeed([]),
          refreshUsageLimits: Effect.succeed([]),
          streamChanges: Stream.empty,
          awaitFirstReadyProvider: Effect.succeed(Option.none()),
          openChanges: Effect.succeed(Stream.empty),
        }),
        Layer.succeed(Open, {
          openBrowser: () => Effect.void,
          openInEditor: () => Effect.void,
          openInTerminal: () => Effect.void,
          openPath: () => Effect.void,
        }),
        ...(retentionStart ? [Layer.mock(ThreadRetention)({ start: retentionStart })] : []),
      ),
    ),
  );
}
