import { createNativeTerminalApi } from "./wsNativeApi.terminal";
import {
  type ContextMenuItem,
  type NativeApi,
  type OrchestrationDeliveryLifecycle,
} from "@bigbud/contracts";
import { openLink } from "../lib/openLink";
import { showContextMenuFallback } from "../utils/context-menu";
import { resetRequestLatencyStateForTests } from "./requestLatencyState";
import { resetServerStateForTests } from "./serverState";
import { resetWsConnectionStateForTests } from "./wsConnectionState";
import {
  resetOrchestrationDeliveryLifecycleForTests,
  setOrchestrationDeliveryLifecycle,
} from "./orchestrationDeliveryState";
import {
  persistDeliveryCursor,
  readPersistedDeliveryCursor,
  resolveDeliveryConsumerId,
} from "./orchestrationDeliveryCursor";
import type { NativeDeliveryCursor } from "./orchestrationDeliveryCursor.scoped";
import { createNativeDelivery } from "./wsNativeApi.delivery";
import { __resetWsRpcClientForTests, getWsRpcClient } from "./wsRpcClient";
import type { WsRpcClient } from "./wsRpcClient.types";
import { isBoundBackendWindow } from "./backendScope.state";

let instance: { api: NativeApi } | null = null;

export function __resetWsNativeApiForTests() {
  instance = null;
  __resetWsRpcClientForTests();
  resetRequestLatencyStateForTests();
  resetServerStateForTests();
  resetWsConnectionStateForTests();
  resetOrchestrationDeliveryLifecycleForTests();
}

/** Existing local entrypoint retains its singleton and legacy cursor storage. */
export function createWsNativeApi(): NativeApi {
  if (isBoundBackendWindow()) throw new Error("A remote backend window has no local native API.");
  if (instance) return instance.api;
  const rpcClient = getWsRpcClient();
  const consumerId = resolveDeliveryConsumerId();
  instance = createWsNativeApiContext({
    rpcClient,
    deliveryCursor: {
      consumerId,
      read: () => readPersistedDeliveryCursor(consumerId),
      write: (sequence) => persistDeliveryCursor(consumerId, sequence),
    },
    onDeliveryLifecycle: setOrchestrationDeliveryLifecycle,
  });
  return instance.api;
}

/** Explicit owner boundary; the caller supplies an authenticated backend client and cursor scope.
 * This factory neither selects a backend nor establishes trust or activates remote UI state. */
export function createWsNativeApiContext({
  rpcClient,
  deliveryCursor,
  onDeliveryLifecycle = () => {},
}: {
  readonly rpcClient: WsRpcClient;
  readonly deliveryCursor: NativeDeliveryCursor;
  readonly onDeliveryLifecycle?: (event: OrchestrationDeliveryLifecycle) => void;
}) {
  const delivery = createNativeDelivery(rpcClient, deliveryCursor, onDeliveryLifecycle);
  const api: NativeApi = {
    dialogs: {
      pickFolder: async () => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder();
      },
      confirm: async (message) => {
        if (window.desktopBridge) {
          return window.desktopBridge.confirm(message);
        }
        return window.confirm(message);
      },
    },
    fileAccess: {
      request: async (level) => {
        if (!window.desktopBridge) {
          return { success: false, granted: [], denied: [] };
        }
        return window.desktopBridge.requestFileAccess(level);
      },
    },
    terminal: createNativeTerminalApi(rpcClient.terminal),
    projects: {
      listDirectory: rpcClient.projects.listDirectory,
      onDirectoryChange: (input, callback, options) =>
        rpcClient.projects.onDirectoryChange(input, callback, options),
      readFilePreview: rpcClient.projects.readFilePreview,
      searchFileContents: rpcClient.projects.searchFileContents,
      searchEntries: rpcClient.projects.searchEntries,
      writeFile: rpcClient.projects.writeFile,
    },
    notes: {
      list: rpcClient.notes.list,
      get: rpcClient.notes.get,
      create: rpcClient.notes.create,
      update: rpcClient.notes.update,
      delete: rpcClient.notes.delete,
    },
    kanban: {
      list: rpcClient.kanban.list,
      get: rpcClient.kanban.get,
      create: rpcClient.kanban.create,
      update: rpcClient.kanban.update,
      delete: rpcClient.kanban.delete,
      move: rpcClient.kanban.move,
      reorder: rpcClient.kanban.reorder,
    },
    teach: {
      listProjects: () => rpcClient.teach.listProjects({}),
    },
    shell: {
      openInEditor: (cwd, editor) => rpcClient.shell.openInEditor({ cwd, editor }),
      openInTerminal: (cwd, terminal) => rpcClient.shell.openInTerminal({ cwd, terminal }),
      openPath: (path) => rpcClient.shell.openPath({ path }),
      openExternal: openLink,
    },
    worktrees: rpcClient.worktrees,
    git: {
      pull: rpcClient.git.pull,
      fetch: rpcClient.git.fetch,
      discardChanges: rpcClient.git.discardChanges,
      refreshStatus: rpcClient.git.refreshStatus,
      listCommits: rpcClient.git.listCommits,
      getCommitDetails: rpcClient.git.getCommitDetails,
      readWorkingTreeDiff: rpcClient.git.readWorkingTreeDiff,
      onStatus: (input, callback) => rpcClient.git.onStatus(input, callback),
      listBranches: rpcClient.git.listBranches,
      createWorktree: rpcClient.git.createWorktree,
      removeWorktree: rpcClient.git.removeWorktree,
      createBranch: rpcClient.git.createBranch,
      renameBranch: rpcClient.git.renameBranch,
      deleteBranch: rpcClient.git.deleteBranch,
      checkout: rpcClient.git.checkout,
      init: rpcClient.git.init,
      resolvePullRequest: rpcClient.git.resolvePullRequest,
      preparePullRequestThread: rpcClient.git.preparePullRequestThread,
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
    },
    server: {
      listRemoteBackendRelayProfiles: rpcClient.server.listRemoteBackendRelayProfiles,
      openRemoteBackendRelay: rpcClient.server.openRemoteBackendRelay,
      closeRemoteBackendRelay: rpcClient.server.closeRemoteBackendRelay,
      getConfig: rpcClient.server.getConfig,
      refreshProviders: rpcClient.server.refreshProviders,
      refreshUsageLimits: rpcClient.server.refreshUsageLimits,
      activateCliProxy: rpcClient.server.activateCliProxy,
      verifyExecutionTarget: rpcClient.server.verifyExecutionTarget,
      listSshConfigHosts: rpcClient.server.listSshConfigHosts,
      listRemoteFolders: rpcClient.server.listRemoteFolders,
      installRemoteAgent: rpcClient.server.installRemoteAgent,
      getRemoteAgentManualInstall: rpcClient.server.getRemoteAgentManualInstall,
      connectRemoteAgent: rpcClient.server.connectRemoteAgent,
      restartRemoteAgent: rpcClient.server.restartRemoteAgent,
      getRemoteAgentRestartStatus: rpcClient.server.getRemoteAgentRestartStatus,
      disconnectExecutionTarget: rpcClient.server.disconnectExecutionTarget,
      connectExecutionTarget: rpcClient.server.connectExecutionTarget,
      listDisconnectedExecutionTargets: rpcClient.server.listDisconnectedExecutionTargets,
      getRemoteAgentUpdateStatus: rpcClient.server.getRemoteAgentUpdateStatus,
      unlockSshKey: rpcClient.server.unlockSshKey,
      unlockSshPassword: rpcClient.server.unlockSshPassword,
      trustSshHost: rpcClient.server.trustSshHost,
      upsertKeybinding: rpcClient.server.upsertKeybinding,
      getSettings: rpcClient.server.getSettings,
      updateSettings: rpcClient.server.updateSettings,
      getDatabaseCompactionStatus: rpcClient.server.getDatabaseCompactionStatus,
      previewDatabaseCompaction: rpcClient.server.previewDatabaseCompaction,
      startDatabaseCompaction: rpcClient.server.startDatabaseCompaction,
      previewThreadRetention: rpcClient.server.previewThreadRetention,
      startThreadRetention: rpcClient.server.startThreadRetention,
      getThreadRetentionRun: rpcClient.server.getThreadRetentionRun,
      listThreadRetentionRuns: rpcClient.server.listThreadRetentionRuns,
      setThreadRetentionPolicy: rpcClient.server.setThreadRetentionPolicy,
      setThreadPinned: rpcClient.server.setThreadPinned,
      readDocumentUrl: rpcClient.server.readDocumentUrl,
      writeHandoffDocument: rpcClient.server.writeHandoffDocument,
      retryTextGeneration: rpcClient.server.retryTextGeneration,
      claimMetadataWarnings: rpcClient.server.claimMetadataWarnings,
      acknowledgeMetadataWarning: rpcClient.server.acknowledgeMetadataWarning,
      startHandoffJob: rpcClient.server.startHandoffJob,
      getHandoffJob: rpcClient.server.getHandoffJob,
      getOpencodeV2ThreadToolsSetup: rpcClient.server.getOpencodeV2ThreadToolsSetup,
      copilotRuntime: rpcClient.server.copilotRuntime,
      createMobileRemotePairing: rpcClient.server.createMobileRemotePairing,
      listMobileRemoteSessions: rpcClient.server.listMobileRemoteSessions,
      revokeMobileRemoteSession: rpcClient.server.revokeMobileRemoteSession,
      exportThreadContext: rpcClient.server.exportThreadContext,
      getAutomation: rpcClient.server.getAutomation,
      listAutomations: rpcClient.server.listAutomations,
      listAllAutomations: rpcClient.server.listAllAutomations,
      createAutomation: rpcClient.server.createAutomation,
      createOwnedAutomation: rpcClient.server.createOwnedAutomation,
      updateAutomation: rpcClient.server.updateAutomation,
      pauseAutomation: rpcClient.server.pauseAutomation,
      resumeAutomation: rpcClient.server.resumeAutomation,
      deleteAutomation: rpcClient.server.deleteAutomation,
      triggerAutomation: rpcClient.server.triggerAutomation,
      listAutomationRuns: rpcClient.server.listAutomationRuns,
      getUsageSummary: rpcClient.server.getUsageSummary,
      getWsConnectionDiagnostics: rpcClient.server.getWsConnectionDiagnostics,
      stopSubagent: rpcClient.server.stopSubagent,
      providerControls: rpcClient.server.providerControls,
    },
    orchestration: {
      getSidebarThreadCatalog: () => rpcClient.orchestration.getSidebarThreadCatalog({}),
      getStartupProjectCatalog: rpcClient.orchestration.getStartupProjectCatalog,
      searchConversationMessages: rpcClient.orchestration.searchConversationMessages,
      getProjectThreadSummaries: rpcClient.orchestration.getProjectThreadSummaries,
      getOrganizationThreadSummaries: rpcClient.orchestration.getOrganizationThreadSummaries,
      getSelectedThreadDetail: rpcClient.orchestration.getSelectedThreadDetail,
      resolveThreadOwnership: async (input) => {
        try {
          return await rpcClient.orchestration.getThreadOwnership(input);
        } catch (error) {
          const message = error instanceof Error ? error.message.trim() : "";
          return {
            threadId: input.threadId,
            status: "unavailable",
            ownership: "unconfirmed",
            reason: message || "Thread ownership could not be confirmed.",
          };
        }
      },
      getCommandOutcome: (input) => rpcClient.orchestration.getCommandOutcome(input),
      getTurnActivities: rpcClient.orchestration.getTurnActivities,
      getMessageTextChunk: rpcClient.orchestration.getMessageTextChunk,
      getProjectWorktreePaths: rpcClient.orchestration.getProjectWorktreePaths,
      startThreadBranch: rpcClient.orchestration.startThreadBranch,
      getThreadBranchCopy: rpcClient.orchestration.getThreadBranchCopy,
      dispatchCommand: rpcClient.orchestration.dispatchCommand,
      getTurnDiff: rpcClient.orchestration.getTurnDiff,
      getFullThreadDiff: rpcClient.orchestration.getFullThreadDiff,
      replayEvents: (fromSequenceExclusive) =>
        rpcClient.orchestration.replayEvents({ fromSequenceExclusive }),
      ...delivery.methods,
      onThinkingDelta: (callback, options) =>
        rpcClient.orchestration.onThinkingDelta(callback, options),
    },
  };

  let disposal: Promise<void> | undefined;
  return {
    api,
    dispose: () => {
      return (disposal ??= (async () => {
        try {
          delivery.dispose();
        } finally {
          await rpcClient.dispose();
        }
      })());
    },
  };
}
