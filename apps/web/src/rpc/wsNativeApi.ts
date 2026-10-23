import { type ContextMenuItem, type NativeApi } from "@bigbud/contracts";

import { openLink } from "../lib/openLink";
import { showContextMenuFallback } from "../utils/context-menu";
import { resetRequestLatencyStateForTests } from "./requestLatencyState";
import { resetServerStateForTests } from "./serverState";
import { resetWsConnectionStateForTests } from "./wsConnectionState";
import {
  resetOrchestrationDeliveryLifecycleForTests,
  setOrchestrationDeliveryLifecycle,
} from "./orchestrationDeliveryState";
import { persistDeliveryCursor, readPersistedDeliveryCursor } from "./orchestrationDeliveryCursor";
import { __resetWsRpcClientForTests, getWsRpcClient } from "./wsRpcClient";
import {
  isWsSubscriptionListenerFailure,
  isWsTransportDisconnectedError,
  wsSubscriptionErrorCause,
} from "./wsTransport.errors";
import { cappedExponentialRetryDelay } from "./wsTransport.retry";
import { resolveDeliveryConsumerId } from "./orchestrationDeliveryCursor";

let instance: { api: NativeApi } | null = null;
const MAX_ORCHESTRATION_NO_PROGRESS_FAILURES = 3;
const ORCHESTRATION_RETRY_BASE_DELAY_MS = 250;
const ORCHESTRATION_RETRY_MAX_DELAY_MS = 8_000;

export function __resetWsNativeApiForTests() {
  instance = null;
  __resetWsRpcClientForTests();
  resetRequestLatencyStateForTests();
  resetServerStateForTests();
  resetWsConnectionStateForTests();
  resetOrchestrationDeliveryLifecycleForTests();
}

export function createWsNativeApi(): NativeApi {
  if (instance) {
    return instance.api;
  }

  const rpcClient = getWsRpcClient();
  const deliveryConsumerId = resolveDeliveryConsumerId();
  let deliveryAppliedSequence = readPersistedDeliveryCursor(deliveryConsumerId);
  type DomainEventCallback = Parameters<NativeApi["orchestration"]["onDomainEvent"]>[0];
  const domainEventCallbacks = new Set<DomainEventCallback>();
  const domainResubscribeCallbacks = new Set<() => void>();
  let activeBaselineRecovery: {
    readonly recoveryId: string;
    readonly consumerId: string;
    readonly consumerGeneration: number;
    readonly serverEpoch: string;
  } | null = null;
  let unsubscribeDomainEvents: (() => void) | null = null;
  let orchestrationApplicationFailures = 0;
  let latestDeliveryIdentity: {
    readonly route: "direct-unmanaged" | "supervisor" | "fallback-fenced";
    readonly consumerGeneration: number;
    readonly acknowledgedSequence: number;
  } | null = null;

  const markDeliveryProgress = () => {
    orchestrationApplicationFailures = 0;
  };
  // An acknowledgement refused mid-batch because the socket dropped is not an application
  // failure; the resubscription replays from `deliveryAppliedSequence` and admission dedupes.
  const isApplicationFailure = (error: unknown) =>
    isWsSubscriptionListenerFailure(error) &&
    !isWsTransportDisconnectedError(wsSubscriptionErrorCause(error));

  const isActiveBaselineRecovery = (input: {
    readonly recoveryId: string;
    readonly consumerId: string;
    readonly consumerGeneration: number;
    readonly serverEpoch: string;
  }) =>
    activeBaselineRecovery?.recoveryId === input.recoveryId &&
    activeBaselineRecovery.consumerId === input.consumerId &&
    activeBaselineRecovery.consumerGeneration === input.consumerGeneration &&
    activeBaselineRecovery.serverEpoch === input.serverEpoch;

  const ensureDomainEventSubscription = () => {
    if (unsubscribeDomainEvents) return;
    unsubscribeDomainEvents = rpcClient.orchestration.onDomainEvent(
      () => ({ consumerId: deliveryConsumerId, appliedSequence: deliveryAppliedSequence }),
      (item) => {
        latestDeliveryIdentity = {
          route: item.route,
          consumerGeneration: item.consumerGeneration,
          acknowledgedSequence:
            item.type === "batch" ? deliveryAppliedSequence : item.acknowledgedSequence,
        };
        if (item.type === "recovery") {
          activeBaselineRecovery = {
            recoveryId: item.recoveryId,
            consumerId: item.consumerId,
            consumerGeneration: item.consumerGeneration,
            serverEpoch: item.serverEpoch,
          };
        } else if (item.type === "batch") {
          activeBaselineRecovery = null;
        }
        return Promise.all(Array.from(domainEventCallbacks, (callback) => callback(item))).then(
          () => undefined,
        );
      },
      {
        retryDelay: ({ error }) =>
          isApplicationFailure(error)
            ? cappedExponentialRetryDelay({
                attempt: orchestrationApplicationFailures,
                baseMs: ORCHESTRATION_RETRY_BASE_DELAY_MS,
                maxMs: ORCHESTRATION_RETRY_MAX_DELAY_MS,
              })
            : ORCHESTRATION_RETRY_BASE_DELAY_MS,
        onResubscribe: () => {
          activeBaselineRecovery = null;
          for (const callback of domainResubscribeCallbacks) callback();
        },
        shouldRetry: (error) => {
          if (!isApplicationFailure(error)) return true;
          orchestrationApplicationFailures += 1;
          const identity = latestDeliveryIdentity;
          if (
            orchestrationApplicationFailures === MAX_ORCHESTRATION_NO_PROGRESS_FAILURES &&
            identity
          ) {
            setOrchestrationDeliveryLifecycle({
              type: "lifecycle",
              route: identity.route,
              consumerId: deliveryConsumerId,
              consumerGeneration: identity.consumerGeneration,
              state: "degraded",
              acknowledgedSequence: identity.acknowledgedSequence,
              restartAttempt: 0,
              reasonCode: "application_no_progress",
            });
          }
          // The supervisor retains the authoritative cursor and will issue a
          // replay or baseline reset on the next generation. Stopping here
          // leaves persisted messages invisible until the renderer restarts.
          return true;
        },
      },
    );
  };

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
    terminal: {
      wslDistributions: () => rpcClient.terminal.wslDistributions(),
      snapshot: (input) => rpcClient.terminal.snapshot(input as never),
      open: (input) => rpcClient.terminal.open(input as never),
      write: (input) => rpcClient.terminal.write(input as never),
      resize: (input) => rpcClient.terminal.resize(input as never),
      clear: (input) => rpcClient.terminal.clear(input as never),
      restart: (input) => rpcClient.terminal.restart(input as never),
      close: (input) => rpcClient.terminal.close(input as never),
      onEvent: (callback) => rpcClient.terminal.onEvent(callback),
      subscribeSession: (input, callback, options) =>
        rpcClient.terminal.subscribeSession(input as never, callback, options),
      ackOutput: (input) => rpcClient.terminal.ackOutput(input),
      search: (input) => rpcClient.terminal.search(input),
    },
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
      getConfig: rpcClient.server.getConfig,
      refreshProviders: rpcClient.server.refreshProviders,
      refreshUsageLimits: rpcClient.server.refreshUsageLimits,
      activateCliProxy: rpcClient.server.activateCliProxy,
      verifyExecutionTarget: rpcClient.server.verifyExecutionTarget,
      listSshConfigHosts: rpcClient.server.listSshConfigHosts,
      listRemoteFolders: rpcClient.server.listRemoteFolders,
      installRemoteAgent: rpcClient.server.installRemoteAgent,
      connectRemoteAgent: rpcClient.server.connectRemoteAgent,
      restartRemoteAgent: rpcClient.server.restartRemoteAgent,
      getRemoteAgentRestartStatus: rpcClient.server.getRemoteAgentRestartStatus,
      getRemoteAgentUpdateStatus: rpcClient.server.getRemoteAgentUpdateStatus,
      unlockSshKey: rpcClient.server.unlockSshKey,
      unlockSshPassword: rpcClient.server.unlockSshPassword,
      trustSshHost: rpcClient.server.trustSshHost,
      upsertKeybinding: rpcClient.server.upsertKeybinding,
      getSettings: rpcClient.server.getSettings,
      updateSettings: rpcClient.server.updateSettings,
      previewThreadRetention: rpcClient.server.previewThreadRetention,
      startThreadRetention: rpcClient.server.startThreadRetention,
      getThreadRetentionRun: rpcClient.server.getThreadRetentionRun,
      listThreadRetentionRuns: rpcClient.server.listThreadRetentionRuns,
      setThreadRetentionPolicy: rpcClient.server.setThreadRetentionPolicy,
      setThreadPinned: rpcClient.server.setThreadPinned,
      readDocumentUrl: rpcClient.server.readDocumentUrl,
      writeHandoffDocument: rpcClient.server.writeHandoffDocument,
      retryTextGeneration: rpcClient.server.retryTextGeneration,
      startHandoffJob: rpcClient.server.startHandoffJob,
      getHandoffJob: rpcClient.server.getHandoffJob,
      getOpencodeV2ThreadToolsSetup: rpcClient.server.getOpencodeV2ThreadToolsSetup,
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
    },
    orchestration: {
      getSidebarThreadCatalog: () => rpcClient.orchestration.getSidebarThreadCatalog({}),
      getStartupProjectCatalog: rpcClient.orchestration.getStartupProjectCatalog,
      searchConversationMessages: rpcClient.orchestration.searchConversationMessages,
      getProjectThreadSummaries: rpcClient.orchestration.getProjectThreadSummaries,
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
      getSnapshot: rpcClient.orchestration.getSnapshot,
      dispatchCommand: rpcClient.orchestration.dispatchCommand,
      getTurnDiff: rpcClient.orchestration.getTurnDiff,
      getFullThreadDiff: rpcClient.orchestration.getFullThreadDiff,
      replayEvents: (fromSequenceExclusive) =>
        rpcClient.orchestration.replayEvents({ fromSequenceExclusive }),
      acknowledgeDelivery: async (input) => {
        const result = await rpcClient.orchestration.acknowledgeDelivery(input);
        if (result.accepted && !result.fenced) {
          deliveryAppliedSequence = Math.max(deliveryAppliedSequence, result.acknowledgedSequence);
          persistDeliveryCursor(deliveryConsumerId, deliveryAppliedSequence);
          markDeliveryProgress();
        }
        return result;
      },
      acknowledgeDeliveryBaseline: async (input) => {
        if (!isActiveBaselineRecovery(input)) {
          return { accepted: false, fenced: true, acknowledgedSequence: deliveryAppliedSequence };
        }
        const result = await rpcClient.orchestration.acknowledgeDeliveryBaseline(input);
        if (result.accepted && !result.fenced && isActiveBaselineRecovery(input)) {
          deliveryAppliedSequence = Math.max(deliveryAppliedSequence, result.acknowledgedSequence);
          persistDeliveryCursor(deliveryConsumerId, deliveryAppliedSequence);
          markDeliveryProgress();
        } else if (result.accepted && !result.fenced) {
          return { accepted: false, fenced: true, acknowledgedSequence: deliveryAppliedSequence };
        }
        return result;
      },
      onDomainEvent: (callback, options) => {
        domainEventCallbacks.add(callback);
        if (options?.onResubscribe) domainResubscribeCallbacks.add(options.onResubscribe);
        ensureDomainEventSubscription();
        return () => {
          domainEventCallbacks.delete(callback);
          if (options?.onResubscribe) domainResubscribeCallbacks.delete(options.onResubscribe);
          if (domainEventCallbacks.size === 0) {
            activeBaselineRecovery = null;
            unsubscribeDomainEvents?.();
            unsubscribeDomainEvents = null;
          }
        };
      },
      onThinkingDelta: (callback, options) =>
        rpcClient.orchestration.onThinkingDelta(callback, options),
    },
  };

  instance = { api };
  return api;
}
