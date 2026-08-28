import { type ContextMenuItem, type NativeApi } from "@bigbud/contracts";

import { openBrowserPanel } from "~/stores/browser/browserPanel.actions";
import { showContextMenuFallback } from "../utils/context-menu";
import { resetRequestLatencyStateForTests } from "./requestLatencyState";
import { resetServerStateForTests } from "./serverState";
import { resetWsConnectionStateForTests } from "./wsConnectionState";
import { resetOrchestrationDeliveryLifecycleForTests } from "./orchestrationDeliveryState";
import { persistDeliveryCursor, readPersistedDeliveryCursor } from "./orchestrationDeliveryCursor";
import { __resetWsRpcClientForTests, getWsRpcClient } from "./wsRpcClient";

let instance: { api: NativeApi } | null = null;
const DELIVERY_CONSUMER_STORAGE_KEY = "bigbud:orchestration-delivery-consumer";

function resolveDeliveryConsumerId(): string {
  try {
    const existing = window.sessionStorage.getItem(DELIVERY_CONSUMER_STORAGE_KEY)?.trim();
    if (existing) return existing;
    const consumerId = crypto.randomUUID();
    window.sessionStorage.setItem(DELIVERY_CONSUMER_STORAGE_KEY, consumerId);
    return consumerId;
  } catch {
    return crypto.randomUUID();
  }
}

function shouldOpenViaDesktopShell(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol !== "http:" && protocol !== "https:";
  } catch {
    return false;
  }
}

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
        onResubscribe: () => {
          activeBaselineRecovery = null;
          for (const callback of domainResubscribeCallbacks) callback();
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
      open: (input) => rpcClient.terminal.open(input as never),
      write: (input) => rpcClient.terminal.write(input as never),
      resize: (input) => rpcClient.terminal.resize(input as never),
      clear: (input) => rpcClient.terminal.clear(input as never),
      restart: (input) => rpcClient.terminal.restart(input as never),
      close: (input) => rpcClient.terminal.close(input as never),
      onEvent: (callback) => rpcClient.terminal.onEvent(callback),
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
      openExternal: async (url) => {
        const nextUrl = url.trim();
        if (!nextUrl) {
          throw new Error("Unable to open link.");
        }

        if (window.desktopBridge && shouldOpenViaDesktopShell(nextUrl)) {
          await window.desktopBridge.openExternal(nextUrl);
          return;
        }

        openBrowserPanel({ url: nextUrl });
      },
    },
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
      activateCliProxy: rpcClient.server.activateCliProxy,
      verifyExecutionTarget: rpcClient.server.verifyExecutionTarget,
      installRemoteAgent: rpcClient.server.installRemoteAgent,
      unlockSshKey: rpcClient.server.unlockSshKey,
      unlockSshPassword: rpcClient.server.unlockSshPassword,
      upsertKeybinding: rpcClient.server.upsertKeybinding,
      getSettings: rpcClient.server.getSettings,
      updateSettings: rpcClient.server.updateSettings,
      previewThreadRetention: rpcClient.server.previewThreadRetention,
      startThreadRetention: rpcClient.server.startThreadRetention,
      setThreadRetentionPolicy: rpcClient.server.setThreadRetentionPolicy,
      setThreadPinned: rpcClient.server.setThreadPinned,
      readDocumentUrl: rpcClient.server.readDocumentUrl,
      writeHandoffDocument: rpcClient.server.writeHandoffDocument,
      startHandoffJob: rpcClient.server.startHandoffJob,
      getHandoffJob: rpcClient.server.getHandoffJob,
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
    },
    orchestration: {
      getSidebarThreadCatalog: () => rpcClient.orchestration.getSidebarThreadCatalog({}),
      getStartupProjectCatalog: rpcClient.orchestration.getStartupProjectCatalog,
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
