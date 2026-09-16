import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ModelSelection, ServerDiscoveryCatalog, ServerSettings } from "@bigbud/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { TextGenerationError } from "@bigbud/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, vi } from "vitest";

import type { DeepPartial } from "@bigbud/shared/Struct";
import {
  BrowserManager,
  BrowserManagerError,
  type BrowserManagerShape,
} from "../../browser/Services/BrowserManager.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import {
  GitStatusBroadcaster,
  type GitStatusBroadcasterShape,
} from "../../git/Services/GitStatusBroadcaster.ts";
import { TextGeneration, type TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadWatchRepository } from "../../persistence/Services/ProjectionThreadWatches.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { DiscoveryRegistry } from "../../provider/Services/DiscoveryRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { deriveServerPaths, ServerConfig } from "../../startup/config.ts";
import {
  TerminalHistoryError,
  TerminalManager,
  type TerminalManagerShape,
} from "../../terminal/Services/Manager.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ComputerUseDisabledTestLayer } from "./OrchestrationEngine.test.helpers.ts";
import { EntityPurgeLive } from "../../deletion/Layers/EntityPurge.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { makeReactorProvider } from "./ProviderCommandReactor.test.provider.ts";
import { ProjectionNoteRepositoryLive } from "../../persistence/Layers/ProjectionNotes.ts";
import { ProjectionKanbanRepositoryLive } from "../../persistence/Layers/ProjectionKanban.ts";
import {
  DirectResourceCleanupExecutor,
  type DirectResourceCleanupExecutorShape,
} from "../../deletion/Services/DirectResourceCleanupExecutor.ts";
import { ProviderCommandReactorLive } from "./ProviderCommandReactor.ts";

const cleanupTasks = new Set<() => Promise<void>>();
const trackedDirs = new Set<string>();

export const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
export const asApprovalRequestId = (value: string): ApprovalRequestId =>
  ApprovalRequestId.makeUnsafe(value);
export const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
export const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

export function registerProviderCommandReactorTestCleanup(): void {
  afterEach(async () => {
    for (const cleanup of cleanupTasks) {
      await cleanup();
    }
    cleanupTasks.clear();

    for (const dir of trackedDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    trackedDirs.clear();
  });
}

export function makeTrackedTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackedDirs.add(dir);
  return dir;
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };

  return poll();
}

export async function createHarness(input?: {
  readonly cleanupExecutor?: DirectResourceCleanupExecutorShape;
  readonly baseDir?: string;
  readonly workspaceRoot?: string;
  readonly threadModelSelection?: ModelSelection;
  readonly sessionModelSwitch?: "unsupported" | "in-session";
  readonly interruptTurnFailure?: string;
  readonly interruptTurnLeavesSessionActive?: boolean;
  readonly stopSessionFailure?: string;
  readonly browserCloseFailure?: string;
  readonly terminalCloseFailure?: string;
  readonly discoveryCatalog?: ServerDiscoveryCatalog;
  readonly serverSettingsOverrides?: DeepPartial<ServerSettings>;
}) {
  const now = new Date().toISOString();
  const baseDir = input?.baseDir ?? makeTrackedTempDir("bigbud-reactor-");
  trackedDirs.add(baseDir);
  const { stateDir } = deriveServerPathsSync(baseDir, undefined);
  trackedDirs.add(stateDir);
  const {
    service,
    modelSelection,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
  } = makeReactorProvider(input, now);
  const renameBranch = vi.fn((gitInput: unknown) =>
    Effect.succeed({
      branch:
        typeof gitInput === "object" &&
        gitInput !== null &&
        "newBranch" in gitInput &&
        typeof gitInput.newBranch === "string"
          ? gitInput.newBranch
          : "renamed-branch",
    }),
  );
  const refreshLocalStatus = vi.fn((_: string) =>
    Effect.succeed({
      isRepo: true,
      hasOriginRemote: true,
      isDefaultBranch: false,
      branch: "renamed-branch",
      hasWorkingTreeChanges: false,
      workingTree: {
        files: [],
        insertions: 0,
        deletions: 0,
      },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    }),
  );
  const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>(() =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateBranchName",
        detail: "disabled in test harness",
      }),
    ),
  );
  const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>(() =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "disabled in test harness",
      }),
    ),
  );
  const generateThreadElevatorSummary = vi.fn<TextGenerationShape["generateThreadElevatorSummary"]>(
    () =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadElevatorSummary",
          detail: "disabled in test harness",
        }),
      ),
  );
  const browserClose = vi.fn<BrowserManagerShape["close"]>(() =>
    input?.browserCloseFailure
      ? Effect.fail(
          new BrowserManagerError({
            message: input.browserCloseFailure,
          }),
        )
      : Effect.void,
  );
  const terminalClose = vi.fn<TerminalManagerShape["close"]>(() =>
    input?.terminalCloseFailure
      ? Effect.fail(
          new TerminalHistoryError({
            operation: "truncate",
            threadId: "thread-1",
            terminalId: "default",
            cause: new Error(input.terminalCloseFailure),
          }),
        )
      : Effect.void,
  );

  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const discoveryCatalog = input?.discoveryCatalog ?? { agents: [], skills: [] };
  const browserService: BrowserManagerShape = {
    launch: () => Effect.void,
    navigate: () => unsupported(),
    screenshot: () => unsupported(),
    click: () => unsupported(),
    drag: () => unsupported(),
    scroll: () => unsupported(),
    typeText: () => unsupported(),
    keyPress: () => unsupported(),
    wait: () => unsupported(),
    getPageInfo: () => unsupported(),
    getPageText: () => unsupported(),
    goBack: () => unsupported(),
    goForward: () => unsupported(),
    reload: () => unsupported(),
    close: browserClose,
    closeAll: () => Effect.void,
  };
  const terminalService: TerminalManagerShape = {
    open: () => unsupported(),
    write: () => unsupported(),
    resize: () => unsupported(),
    clear: () => unsupported(),
    restart: () => unsupported(),
    close: terminalClose,
    subscribe: () => Effect.succeed(() => undefined),
  };

  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(ComputerUseDisabledTestLayer),
  );
  const layer = ProviderCommandReactorLive.pipe(
    Layer.provideMerge(ProjectionNoteRepositoryLive),
    Layer.provideMerge(ProjectionKanbanRepositoryLive),
    Layer.provide(
      input?.cleanupExecutor
        ? Layer.succeed(DirectResourceCleanupExecutor, input.cleanupExecutor)
        : Layer.empty,
    ),
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(
      Layer.succeed(ProjectionThreadWatchRepository, {
        addActiveWatch: () => Effect.void,
        replaceActiveWatchesForMessage: () => Effect.void,
        listActiveByWatchedThread: () => Effect.succeed([]),
        listActiveByWatcherAndMessage: () => Effect.succeed([]),
        listActiveByWatcher: () => Effect.succeed([]),
        markGroupTriggered: () => Effect.succeed(false),
        cancelActiveForWatcher: () => Effect.void,
        listAllActive: () => Effect.succeed([]),
      }),
    ),
    Layer.provideMerge(Layer.succeed(ProviderService, service)),
    Layer.provideMerge(
      Layer.succeed(DiscoveryRegistry, {
        getCatalog: Effect.succeed(discoveryCatalog),
        refresh: () => Effect.succeed(discoveryCatalog),
        streamChanges: Stream.empty,
      }),
    ),
    Layer.provideMerge(Layer.succeed(GitCore, { renameBranch } as unknown as GitCoreShape)),
    Layer.provideMerge(
      Layer.succeed(GitStatusBroadcaster, {
        refreshLocalStatus,
      } as unknown as GitStatusBroadcasterShape),
    ),
    Layer.provideMerge(
      Layer.mock(TextGeneration, {
        generateBranchName,
        generateThreadTitle,
        generateThreadElevatorSummary,
      }),
    ),
    Layer.provideMerge(Layer.succeed(BrowserManager, browserService)),
    Layer.provideMerge(Layer.succeed(TerminalManager, terminalService)),
    Layer.provideMerge(EntityPurgeLive),
    Layer.provideMerge(
      OrchestrationProjectionPipelineLive.pipe(Layer.provide(OrchestrationEventStoreLive)),
    ),
    Layer.provideMerge(ServerSettingsService.layerTest(input?.serverSettingsOverrides ?? {})),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(WorkspacePathsLive),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);

  let scope: Scope.Closeable | null = null;
  cleanupTasks.add(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    await runtime.dispose();
  });

  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const projectionPipeline = await runtime.runPromise(
    Effect.service(OrchestrationProjectionPipeline),
  );
  const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  scope = await Effect.runPromise(Scope.make("sequential"));
  await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
  const drain = () => Effect.runPromise(reactor.drain);

  await Effect.runPromise(
    engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-project-create"),
      projectId: asProjectId("project-1"),
      title: "Provider Project",
      workspaceRoot: input?.workspaceRoot ?? "/tmp/provider-project",
      defaultModelSelection: modelSelection,
      createdAt: now,
    }),
  );
  await Effect.runPromise(
    engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe("cmd-thread-create"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      projectId: asProjectId("project-1"),
      title: "New thread",
      modelSelection,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
    }),
  );

  return {
    engine,
    projectionPipeline,
    sql,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    renameBranch,
    refreshLocalStatus,
    generateBranchName,
    generateThreadTitle,
    generateThreadElevatorSummary,
    browserClose,
    terminalClose,
    stateDir,
    drain,
  };
}
