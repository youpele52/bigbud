import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, FileSystem, Layer, ManagedRuntime, Path, Ref, Scope, Stream } from "effect";

import { CheckpointStoreLive } from "../src/checkpointing/Layers/CheckpointStore.ts";
import { CheckpointStore } from "../src/checkpointing/Services/CheckpointStore.ts";
import { GitCoreLive } from "../src/git/Layers/GitCore.ts";
import { GitCore, type GitCoreShape } from "../src/git/Services/GitCore.ts";
import { GitStatusBroadcaster } from "../src/git/Services/GitStatusBroadcaster.ts";
import { TextGeneration, type TextGenerationShape } from "../src/git/Services/TextGeneration.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionCheckpointRepositoryLive } from "../src/persistence/Layers/ProjectionCheckpoints.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../src/persistence/Layers/ProjectionPendingApprovals.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../src/persistence/Layers/ProviderSessionRuntime.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { ProjectionThreadWatchRepositoryLive } from "../src/persistence/Layers/ProjectionThreadWatches.ts";
import { ProjectionCheckpointRepository } from "../src/persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionPendingApprovalRepository } from "../src/persistence/Services/ProjectionPendingApprovals.ts";
import { ProviderUnsupportedError } from "../src/provider/Errors.ts";
import { DiscoveryRegistry } from "../src/provider/Services/DiscoveryRegistry.ts";
import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../src/ws/serverSettings.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import { makeCodexAdapterLive } from "../src/provider/Layers/Codex/Adapter.ts";
import { CodexAdapter } from "../src/provider/Services/Codex/Adapter.ts";
import { ProviderService } from "../src/provider/Services/ProviderService.ts";
import { AnalyticsService } from "../src/telemetry/Services/AnalyticsService.ts";
import { CheckpointReactorLive } from "../src/orchestration/Layers/CheckpointReactor.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusTest } from "../src/orchestration/Layers/RuntimeReceiptBus.ts";
import { OrchestrationReactorLive } from "../src/orchestration/Layers/OrchestrationReactor.ts";
import { ProviderCommandReactorLive } from "../src/orchestration/Layers/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionLive } from "../src/orchestration/Layers/ProviderRuntimeIngestion.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationReactor } from "../src/orchestration/Services/OrchestrationReactor.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { SchedulerReactor } from "../src/orchestration/Services/SchedulerReactor.ts";
import { ThreadWatchReactor } from "../src/orchestration/Services/ThreadWatchReactor.ts";
import {
  RuntimeReceiptBus,
  type OrchestrationRuntimeReceipt,
} from "../src/orchestration/Services/RuntimeReceiptBus.ts";

import { makeTestProviderAdapterHarness } from "./TestProviderAdapter.integration.ts";
import { deriveServerPaths, ServerConfig } from "../src/startup/config.ts";
import { WorkspaceEntriesLive } from "../src/workspace/Layers/WorkspaceEntries.ts";
import { WorkspacePathsLive } from "../src/workspace/Layers/WorkspacePaths.ts";
import { BrowserManager } from "../src/browser/Services/BrowserManager.ts";
import { TerminalManager } from "../src/terminal/Services/Manager.ts";

import {
  initializeGitWorkspace,
  tryRuntimePromise,
} from "./OrchestrationEngineHarness.integration.shared.ts";
import type {
  MakeOrchestrationIntegrationHarnessOptions,
  OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.types.ts";
import { createHarnessRuntimeControls } from "./OrchestrationEngineHarness.integration.waiters.ts";

export { gitRefExists, gitShowFileAtRef } from "./OrchestrationEngineHarness.integration.shared.ts";
export type { OrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.types.ts";

export const makeOrchestrationIntegrationHarness = (
  options?: MakeOrchestrationIntegrationHarnessOptions,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;

    const provider = options?.provider ?? "codex";
    const useRealCodex = options?.realCodex === true;
    const adapterHarness = useRealCodex
      ? null
      : yield* makeTestProviderAdapterHarness({
          provider,
        });
    const fakeRegistry = adapterHarness
      ? Layer.succeed(ProviderAdapterRegistry, {
          getByProvider: (resolvedProvider) =>
            resolvedProvider === adapterHarness.provider
              ? Effect.succeed(adapterHarness.adapter)
              : Effect.fail(new ProviderUnsupportedError({ provider: resolvedProvider })),
          listProviders: () => Effect.succeed([adapterHarness.provider]),
        } as typeof ProviderAdapterRegistry.Service)
      : null;
    const rootDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-orchestration-integration-",
    });
    const workspaceDir = path.join(rootDir, "workspace");
    const { stateDir, dbPath } = yield* deriveServerPaths(rootDir, undefined).pipe(
      Effect.provideService(Path.Path, path),
    );
    yield* fileSystem.makeDirectory(workspaceDir, { recursive: true });
    yield* fileSystem.makeDirectory(stateDir, { recursive: true });
    yield* initializeGitWorkspace(workspaceDir);

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    );
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    const realCodexRegistry = Layer.effect(
      ProviderAdapterRegistry,
      Effect.gen(function* () {
        const codexAdapter = yield* CodexAdapter;
        return {
          getByProvider: (resolvedProvider) =>
            resolvedProvider === "codex"
              ? Effect.succeed(codexAdapter)
              : Effect.fail(new ProviderUnsupportedError({ provider: resolvedProvider })),
          listProviders: () => Effect.succeed(["codex"] as const),
        } as typeof ProviderAdapterRegistry.Service;
      }),
    ).pipe(
      Layer.provide(makeCodexAdapterLive()),
      Layer.provideMerge(ServerConfig.layerTest(workspaceDir, rootDir)),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(providerSessionDirectoryLayer),
    );
    const providerLayer = useRealCodex
      ? makeProviderServiceLive().pipe(
          Layer.provide(providerSessionDirectoryLayer),
          Layer.provide(realCodexRegistry),
          Layer.provide(AnalyticsService.layerTest),
        )
      : makeProviderServiceLive().pipe(
          Layer.provide(providerSessionDirectoryLayer),
          Layer.provide(fakeRegistry!),
          Layer.provide(AnalyticsService.layerTest),
        );

    const checkpointStoreLayer = CheckpointStoreLive.pipe(Layer.provide(GitCoreLive));
    const projectionSnapshotQueryLayer = OrchestrationProjectionSnapshotQueryLive;
    const runtimeServicesLayer = Layer.mergeAll(
      projectionSnapshotQueryLayer,
      orchestrationLayer.pipe(Layer.provide(projectionSnapshotQueryLayer)),
      ProjectionCheckpointRepositoryLive,
      ProjectionPendingApprovalRepositoryLive,
      checkpointStoreLayer,
      providerLayer,
      RuntimeReceiptBusTest,
    );
    const serverSettingsLayer = ServerSettingsService.layerTest();
    const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(serverSettingsLayer),
    );
    const gitCoreLayer = Layer.succeed(GitCore, {
      renameBranch: (input: Parameters<GitCoreShape["renameBranch"]>[0]) =>
        Effect.succeed({ branch: input.newBranch }),
    } as unknown as GitCoreShape);
    const textGenerationLayer = Layer.succeed(TextGeneration, {
      generateBranchName: () => Effect.succeed({ branch: "update" }),
      generateThreadTitle: () => Effect.succeed({ title: "New thread" }),
    } as unknown as TextGenerationShape);
    const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(
        Layer.succeed(DiscoveryRegistry, {
          getCatalog: Effect.succeed({ agents: [], skills: [] }),
          refresh: () => Effect.succeed({ agents: [], skills: [] }),
          streamChanges: Stream.empty,
        }),
      ),
      Layer.provideMerge(gitCoreLayer),
      Layer.provideMerge(textGenerationLayer),
      Layer.provideMerge(serverSettingsLayer),
      Layer.provide(persistenceLayer.pipe(Layer.provideMerge(ProjectionThreadWatchRepositoryLive))),
    );
    const checkpointReactorLayer = CheckpointReactorLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(
        Layer.succeed(GitStatusBroadcaster, {
          subscribe: () => Stream.empty.pipe(Effect.succeed),
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasOriginRemote: false,
              isDefaultBranch: true,
              branch: "main",
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          invalidateLocal: () => Effect.void,
          invalidateRemote: () => Effect.void,
        }),
      ),
      Layer.provideMerge(
        WorkspaceEntriesLive.pipe(
          Layer.provide(WorkspacePathsLive),
          Layer.provideMerge(gitCoreLayer),
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provideMerge(WorkspacePathsLive),
    );
    const browserLayer = Layer.succeed(BrowserManager, {
      launch: () => Effect.void,
      navigate: () => Effect.die(new Error("Unexpected browser navigate in integration harness")),
      screenshot: () =>
        Effect.die(new Error("Unexpected browser screenshot in integration harness")),
      getPageInfo: () =>
        Effect.die(new Error("Unexpected browser page info in integration harness")),
      close: () => Effect.void,
      closeAll: () => Effect.void,
    });
    const terminalLayer = Layer.succeed(TerminalManager, {
      open: () => Effect.die(new Error("Unexpected terminal open in integration harness")),
      write: () => Effect.die(new Error("Unexpected terminal write in integration harness")),
      resize: () => Effect.die(new Error("Unexpected terminal resize in integration harness")),
      clear: () => Effect.die(new Error("Unexpected terminal clear in integration harness")),
      restart: () => Effect.die(new Error("Unexpected terminal restart in integration harness")),
      close: () => Effect.void,
      subscribe: () => Effect.succeed(() => undefined),
    });
    const schedulerReactorLayer = Layer.succeed(SchedulerReactor, {
      start: () => Effect.void,
      triggerNow: () => Effect.succeed({ status: "dispatched" as const }),
    });
    const threadWatchReactorLayer = Layer.succeed(ThreadWatchReactor, {
      start: () => Effect.void,
    });
    const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
      Layer.provideMerge(runtimeIngestionLayer),
      Layer.provideMerge(providerCommandReactorLayer),
      Layer.provideMerge(checkpointReactorLayer),
      Layer.provideMerge(schedulerReactorLayer),
      Layer.provideMerge(threadWatchReactorLayer),
    );
    const layer = Layer.empty.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(orchestrationReactorLayer),
      Layer.provideMerge(browserLayer),
      Layer.provideMerge(terminalLayer),
      Layer.provide(persistenceLayer),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(workspaceDir, rootDir)),
      Layer.provideMerge(NodeServices.layer),
    );

    const runtime = ManagedRuntime.make(layer);
    const engine = yield* tryRuntimePromise("load OrchestrationEngine service", () =>
      runtime.runPromise(Effect.service(OrchestrationEngineService)),
    ).pipe(Effect.orDie);
    const reactor = yield* tryRuntimePromise("load OrchestrationReactor service", () =>
      runtime.runPromise(Effect.service(OrchestrationReactor)),
    ).pipe(Effect.orDie);
    const snapshotQuery = yield* tryRuntimePromise("load ProjectionSnapshotQuery service", () =>
      runtime.runPromise(Effect.service(ProjectionSnapshotQuery)),
    ).pipe(Effect.orDie);
    const providerService = yield* tryRuntimePromise("load ProviderService service", () =>
      runtime.runPromise(Effect.service(ProviderService)),
    ).pipe(Effect.orDie);
    const checkpointStore = yield* tryRuntimePromise("load CheckpointStore service", () =>
      runtime.runPromise(Effect.service(CheckpointStore)),
    ).pipe(Effect.orDie);
    const checkpointRepository = yield* tryRuntimePromise(
      "load ProjectionCheckpointRepository service",
      () => runtime.runPromise(Effect.service(ProjectionCheckpointRepository)),
    ).pipe(Effect.orDie);
    const pendingApprovalRepository = yield* tryRuntimePromise(
      "load ProjectionPendingApprovalRepository service",
      () => runtime.runPromise(Effect.service(ProjectionPendingApprovalRepository)),
    ).pipe(Effect.orDie);
    const runtimeReceiptBus = yield* tryRuntimePromise("load RuntimeReceiptBus service", () =>
      runtime.runPromise(Effect.service(RuntimeReceiptBus)),
    ).pipe(Effect.orDie);

    const scope = yield* Scope.make("sequential");
    yield* tryRuntimePromise("start OrchestrationReactor", () =>
      runtime.runPromise(reactor.start().pipe(Scope.provide(scope))),
    ).pipe(Effect.orDie);
    const receiptHistory = yield* Ref.make<ReadonlyArray<OrchestrationRuntimeReceipt>>([]);
    yield* Stream.runForEach(runtimeReceiptBus.streamEventsForTest, (receipt) =>
      Ref.update(receiptHistory, (history) => [...history, receipt]).pipe(Effect.asVoid),
    ).pipe(Effect.forkIn(scope));
    yield* Effect.sleep(10);

    const { waitForThread, waitForDomainEvent, waitForPendingApproval, waitForReceipt, dispose } =
      createHarnessRuntimeControls({
        engine,
        snapshotQuery,
        pendingApprovalRepository,
        receiptHistory,
        closeScope: Scope.close(scope, Exit.void),
        disposeRuntime: () => runtime.dispose(),
      });

    return {
      rootDir,
      workspaceDir,
      dbPath,
      adapterHarness,
      engine,
      snapshotQuery,
      providerService,
      checkpointStore,
      checkpointRepository,
      pendingApprovalRepository,
      waitForThread,
      waitForDomainEvent,
      waitForPendingApproval,
      waitForReceipt,
      dispose,
    } satisfies OrchestrationIntegrationHarness;
  });
