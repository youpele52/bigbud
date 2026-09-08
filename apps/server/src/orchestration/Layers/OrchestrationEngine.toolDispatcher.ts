import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import type { OrchestrationReadModel } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { Effect, Option } from "effect";
import type { FileSystem, Path } from "effect";

import type { BrowserManagerShape } from "../../browser/Services/BrowserManager.ts";
import {
  setVisibleBrowserControl,
  type VisibleBrowserControlShape,
} from "../../browser/Services/VisibleBrowserControl.ts";
import type { ComputerUseShape } from "../../computer-use/Services/ComputerUse.ts";
import { computerUseViaOrchestration } from "../../orchestration-tools/ThreadComputerUseTools.ts";
import {
  archiveThreadViaOrchestration as archiveThreadViaThreadTools,
  createThreadViaOrchestration,
  getThreadStatusViaOrchestration as getThreadStatusViaThreadTools,
  listPinnedThreadsViaOrchestration as listPinnedThreadsViaThreadTools,
  renameThreadViaOrchestration as renameThreadViaThreadTools,
  setThreadPinnedViaOrchestration as setThreadPinnedViaThreadTools,
} from "../../orchestration-tools/ThreadOrchestrationTools.ts";
import { listThreadsViaOrchestration } from "../../orchestration-tools/ThreadOrchestrationTools.listThreads.ts";
import { sendThreadMessageViaOrchestration } from "../../orchestration-tools/ThreadOrchestrationTools.sendMessage.ts";
import { makeAgentWorkspaceTool } from "../../orchestration-tools/AgentWorkspaceTools.ts";
import { setThreadOrchestrationToolDispatcher } from "../../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import type { ProjectionKanbanRepositoryShape } from "../../persistence/Services/ProjectionKanban.ts";
import type { ProjectionNoteRepositoryShape } from "../../persistence/Services/ProjectionNotes.ts";
import type { ProjectionThreadWatchRepositoryShape } from "../../persistence/Services/ProjectionThreadWatches.ts";
import type { ThreadDelegationRepositoryShape } from "../../persistence/Services/ThreadDelegations.ts";
import type { ServerConfigShape } from "../../startup/config.ts";
import type { ServerSettingsShape } from "../../ws/serverSettings.ts";
import type { ProjectionCatalogQueryShape } from "../Services/ProjectionCatalogQuery.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { executeBrowserAction } from "./OrchestrationEngine.browser.ts";

export function installOrchestrationEngineToolDispatchers(input: {
  readonly browser: BrowserManagerShape;
  readonly computerUse: ComputerUseShape;
  readonly engine: OrchestrationEngineShape;
  readonly fileSystem: FileSystem.FileSystem;
  readonly kanban: Option.Option<ProjectionKanbanRepositoryShape>;
  readonly notes: Option.Option<ProjectionNoteRepositoryShape>;
  readonly path: Path.Path;
  readonly projectionCatalogQuery: Option.Option<ProjectionCatalogQueryShape>;
  readonly readModel: () => OrchestrationReadModel;
  readonly serverConfig: ServerConfigShape;
  readonly serverSettingsService: ServerSettingsShape;
  readonly threadDelegationRepository: ThreadDelegationRepositoryShape;
  readonly threadWatchRepository: ProjectionThreadWatchRepositoryShape;
  readonly visibleBrowser: VisibleBrowserControlShape;
}) {
  setThreadOrchestrationToolDispatcher({
    ...(Option.isSome(input.notes) && Option.isSome(input.kanban)
      ? {
          workspace: makeAgentWorkspaceTool({
            readModel: input.readModel,
            notes: input.notes.value,
            kanban: input.kanban.value,
          }),
        }
      : {}),
    rename: (request) =>
      renameThreadViaThreadTools({
        orchestrationEngine: input.engine,
        threadId: request.threadId,
        title: request.title,
      }),
    archive: (request) =>
      archiveThreadViaThreadTools({
        orchestrationEngine: input.engine,
        threadId: request.threadId,
      }),
    getStatus: (request) =>
      getThreadStatusViaThreadTools({
        orchestrationEngine: input.engine,
        threadDelegationRepository:
          request.threadDelegationRepository ?? input.threadDelegationRepository,
        callerThreadId: request.callerThreadId,
        threadId: request.threadId,
      }),
    listPinned: (request) =>
      listPinnedThreadsViaThreadTools({
        orchestrationEngine: input.engine,
        callerThreadId: request.callerThreadId,
      }),
    ...(Option.isSome(input.projectionCatalogQuery)
      ? (() => {
          const projectionCatalogQuery = input.projectionCatalogQuery.value;
          return {
            listThreads: (request) =>
              listThreadsViaOrchestration({
                projectionCatalogQuery,
                ...request,
              }),
          };
        })()
      : {}),
    setPinned: (request) =>
      setThreadPinnedViaThreadTools({
        orchestrationEngine: input.engine,
        callerThreadId: request.callerThreadId,
        threadId: request.threadId,
        pinned: request.pinned,
      }),
    sendMessage: (request) =>
      sendThreadMessageViaOrchestration({
        orchestrationEngine: input.engine,
        threadDelegationRepository: input.threadDelegationRepository,
        ...request,
      }),
    computerUse: (request) =>
      Effect.gen(function* () {
        const settings = yield* input.serverSettingsService.getSettings.pipe(
          Effect.catch(() => Effect.succeed(DEFAULT_SERVER_SETTINGS)),
        );
        return yield* computerUseViaOrchestration({
          attachmentsDir: input.serverConfig.attachmentsDir,
          computerUse: input.computerUse,
          computerUseEnabled: settings.computerUseEnabled,
          fileSystem: input.fileSystem,
          orchestrationEngine: input.engine,
          path: input.path,
          serverMode: input.serverConfig.mode,
          threadId: request.threadId,
          action: request.action,
          checkInIntervalMs: settings.computerUseCheckInIntervalMs,
          actionTimeoutMs: settings.computerUseActionTimeoutMs,
        });
      }),
    browser: (request) =>
      executeBrowserAction({
        browser: input.browser,
        readModel: input.readModel,
        threadId: request.threadId,
        action: request.action,
        visibleBrowser: input.visibleBrowser,
      }),
    createThread: (request) =>
      createThreadViaOrchestration({
        orchestrationEngine: input.engine,
        threadDelegationRepository: input.threadDelegationRepository,
        projectionThreadWatchRepository: input.threadWatchRepository,
        callerThreadId: request.callerThreadId,
        sourceMessageId: request.sourceMessageId,
        invocationId: request.invocationId,
        title: request.title,
        task: request.task,
        ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
        watchForCompletion: request.watchForCompletion,
      }),
  });
  setVisibleBrowserControl(input.visibleBrowser);
  return Effect.addFinalizer(() =>
    Effect.gen(function* () {
      setThreadOrchestrationToolDispatcher(null);
      setVisibleBrowserControl(null);
      yield* input.computerUse.dispose;
    }),
  );
}
