import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@bigbud/contracts";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../startup/config.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { asProjectId, ComputerUseDisabledTestLayer } from "./OrchestrationEngine.test.helpers.ts";

describe("OrchestrationEngine", () => {
  it("bootstraps the in-memory read model from persisted projections", async () => {
    const failOnHistoricalReplayStore: OrchestrationEventStoreShape = {
      append: () =>
        Effect.fail(
          new PersistenceSqlError({
            operation: "test.append",
            detail: "append should not be called during bootstrap",
          }),
        ),
      readFromSequence: () => Stream.empty,
      readAll: () =>
        Stream.fail(
          new PersistenceSqlError({
            operation: "test.readAll",
            detail: "historical replay should not be used during bootstrap",
          }),
        ),
    };

    const projectionSnapshot = {
      snapshotSequence: 7,
      updatedAt: "2026-03-03T00:00:04.000Z",
      projects: [
        {
          id: asProjectId("project-bootstrap"),
          title: "Bootstrap Project",
          workspaceRoot: "/tmp/project-bootstrap",
          defaultModelSelection: {
            provider: "codex" as const,
            model: "gpt-5-codex",
          },
          scripts: [],
          createdAt: "2026-03-03T00:00:00.000Z",
          updatedAt: "2026-03-03T00:00:01.000Z",
          deletingAt: null,
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: ThreadId.makeUnsafe("thread-bootstrap"),
          projectId: asProjectId("project-bootstrap"),
          title: "Bootstrap Thread",
          elevatorSummary: "Bootstrap Thread",
          elevatorSummaryMessageCount: 0,
          modelSelection: {
            provider: "codex" as const,
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access" as const,
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-03-03T00:00:02.000Z",
          updatedAt: "2026-03-03T00:00:03.000Z",
          archivedAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          watchingThreads: [],
          session: null,
        },
      ],
    };

    const layer = OrchestrationEngineLive.pipe(
      Layer.provide(
        Layer.succeed(ProjectionSnapshotQuery, {
          getSnapshot: () => Effect.succeed(projectionSnapshot),
          getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 1 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        }),
      ),
      Layer.provide(
        Layer.succeed(OrchestrationProjectionPipeline, {
          bootstrap: Effect.void,
          projectEvent: () => Effect.void,
        } satisfies OrchestrationProjectionPipelineShape),
      ),
      Layer.provide(Layer.succeed(OrchestrationEventStore, failOnHistoricalReplayStore)),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provideMerge(ComputerUseDisabledTestLayer),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    const runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const readModel = await runtime.runPromise(engine.getReadModel());

    expect(readModel.snapshotSequence).toBe(7);
    expect(readModel.projects).toHaveLength(1);
    expect(readModel.projects[0]?.title).toBe("Bootstrap Project");
    expect(readModel.threads).toHaveLength(1);
    expect(readModel.threads[0]?.title).toBe("Bootstrap Thread");

    await runtime.dispose();
  });
});
