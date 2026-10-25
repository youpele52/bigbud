import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@bigbud/contracts";

import { randomUUID } from "~/lib/utils";

import { resetWsReconnectBackoff } from "./wsConnectionState";
import { WsTransport } from "./wsTransport";
import {
  attachWsConnectionDiagnosticsTransport,
  resetWsConnectionDiagnosticsReporterForTests,
  wsConnectionDiagnosticsLifecycle,
} from "./wsConnectionDiagnosticsReporter";
import { requestServerConfig } from "./wsRpcClient.config";
import { requestWsConnectionDiagnostics } from "./wsRpcClient.diagnostics";
import { requestRemoteFolders, requestSshConfigHosts } from "./wsRpcClient.remoteSetup";
import { runGitStackedAction, withGitMutationOperationId } from "./wsRpcClient.git";
import { createTerminalRpcClient } from "./wsRpcClient.terminal";
import { type StreamSubscriptionOptions, type WsRpcClient } from "./wsRpcClient.types";

let sharedWsRpcClient: WsRpcClient | null = null;

export function getWsRpcClient(): WsRpcClient {
  if (sharedWsRpcClient) {
    return sharedWsRpcClient;
  }
  // Only the shared transport reports connection transitions to the server.
  const transport = new WsTransport(undefined, wsConnectionDiagnosticsLifecycle);
  sharedWsRpcClient = createWsRpcClient(transport);
  attachWsConnectionDiagnosticsTransport(transport);
  return sharedWsRpcClient;
}

export async function __resetWsRpcClientForTests() {
  await sharedWsRpcClient?.dispose();
  sharedWsRpcClient = null;
  resetWsConnectionDiagnosticsReporterForTests();
}

function subscribeEmptyInput<TEvent>(
  transport: WsTransport,
  method: (client: any) => { (_input: {}): any },
  listener: (event: TEvent) => void,
  options?: StreamSubscriptionOptions,
) {
  return transport.subscribe((client) => method(client)({}), listener, options);
}

export function createWsRpcClient(transport = new WsTransport()): WsRpcClient {
  return {
    dispose: () => transport.dispose(),
    reconnect: async () => {
      resetWsReconnectBackoff();
      await transport.reconnect();
    },
    reconnectNow: () => transport.reconnectNow(),
    terminal: createTerminalRpcClient(transport),
    browser: {
      completeCommand: (input) =>
        transport.request((client) => client[WS_METHODS.completeVisibleBrowserCommand](input)),
      revokeLease: (input) =>
        transport.request((client) => client[WS_METHODS.revokeVisibleBrowserLease](input)),
      getLeases: (input) =>
        transport.request((client) => client[WS_METHODS.getVisibleBrowserLeases](input)),
      onCommand: (rendererId, listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeVisibleBrowserCommands]({ rendererId }),
          listener,
          options,
        ),
    },
    projects: {
      listDirectory: (input) =>
        transport.request((client) => client[WS_METHODS.projectsListDirectory](input)),
      onDirectoryChange: (input, listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeProjectDirectoryChanges](input),
          listener,
          options,
        ),
      readFilePreview: (input) =>
        transport.request((client) => client[WS_METHODS.projectsReadFilePreview](input)),
      searchFileContents: (input) =>
        transport.request((client) => client[WS_METHODS.projectsSearchFileContents](input)),
      searchEntries: (input) =>
        transport.request((client) => client[WS_METHODS.projectsSearchEntries](input)),
      writeFile: (input) => {
        const operationInput = input.operationId
          ? input
          : { ...input, operationId: `workspace-write-${randomUUID()}` };
        return transport.request((client) => client[WS_METHODS.projectsWriteFile](operationInput));
      },
    },
    notes: {
      list: (input) => transport.request((client) => client[WS_METHODS.notesList](input)),
      get: (input) => transport.request((client) => client[WS_METHODS.notesGet](input)),
      create: (input) => transport.request((client) => client[WS_METHODS.notesCreate](input)),
      update: (input) => transport.request((client) => client[WS_METHODS.notesUpdate](input)),
      delete: (input) => transport.request((client) => client[WS_METHODS.notesDelete](input)),
    },
    kanban: {
      list: (input) => transport.request((client) => client[WS_METHODS.kanbanList](input)),
      get: (input) => transport.request((client) => client[WS_METHODS.kanbanGet](input)),
      create: (input) => transport.request((client) => client[WS_METHODS.kanbanCreate](input)),
      update: (input) => transport.request((client) => client[WS_METHODS.kanbanUpdate](input)),
      delete: (input) => transport.request((client) => client[WS_METHODS.kanbanDelete](input)),
      move: (input) => transport.request((client) => client[WS_METHODS.kanbanMove](input)),
      reorder: (input) => transport.request((client) => client[WS_METHODS.kanbanReorder](input)),
    },
    teach: {
      listProjects: (input) =>
        transport.request((client) => client[WS_METHODS.teachListProjects](input)),
    },
    shell: {
      openInEditor: (input) =>
        transport.request((client) => client[WS_METHODS.shellOpenInEditor](input)),
      openInTerminal: (input) =>
        transport.request((client) => client[WS_METHODS.shellOpenInTerminal](input)),
      openPath: (input) => transport.request((client) => client[WS_METHODS.shellOpenPath](input)),
    },
    worktrees: {
      operations: (input) => transport.request((client) => client["worktrees.operations"](input)),
      recover: (input) => transport.request((client) => client["worktrees.recover"](input)),
      list: (input) => transport.request((client) => client["worktrees.list"](input)),
      create: (input) => transport.request((client) => client["worktrees.create"](input)),
      delete: (input) => transport.request((client) => client["worktrees.delete"](input)),
      select: (input) => transport.request((client) => client["worktrees.select"](input)),
    },
    git: {
      pull: (input) => {
        const operationInput = withGitMutationOperationId(input);
        return transport.request((client) => client[WS_METHODS.gitPull](operationInput));
      },
      refreshStatus: (input) =>
        transport.request((client) => client[WS_METHODS.gitRefreshStatus](input)),
      listCommits: (input) =>
        transport.request((client) => client[WS_METHODS.gitListCommits](input)),
      getCommitDetails: (input) =>
        transport.request((client) => client[WS_METHODS.gitGetCommitDetails](input)),
      readWorkingTreeDiff: (input) =>
        transport.request((client) => client[WS_METHODS.gitReadWorkingTreeDiff](input)),
      onStatus: (input, listener) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeGitStatus](input), listener),
      runStackedAction: (input, options) => runGitStackedAction(transport, input, options),
      listBranches: (input) =>
        transport.request((client) => client[WS_METHODS.gitListBranches](input)),
      createWorktree: (input) => {
        const operationInput = withGitMutationOperationId(input);
        return transport.request((client) => client[WS_METHODS.gitCreateWorktree](operationInput));
      },
      removeWorktree: (input) => {
        const operationInput = withGitMutationOperationId(input);
        return transport.request((client) => client[WS_METHODS.gitRemoveWorktree](operationInput));
      },
      createBranch: (input) => {
        const operationInput = withGitMutationOperationId(input);
        return transport.request((client) => client[WS_METHODS.gitCreateBranch](operationInput));
      },
      renameBranch: (input) => {
        const operationInput = withGitMutationOperationId(input);
        return transport.request((client) => client[WS_METHODS.gitRenameBranch](operationInput));
      },
      deleteBranch: (input) => {
        const operationInput = withGitMutationOperationId(input);
        return transport.request((client) => client[WS_METHODS.gitDeleteBranch](operationInput));
      },
      checkout: (input) => {
        const operationInput = withGitMutationOperationId(input);
        return transport.request((client) => client[WS_METHODS.gitCheckout](operationInput));
      },
      init: (input) => {
        const operationInput = withGitMutationOperationId(input);
        return transport.request((client) => client[WS_METHODS.gitInit](operationInput));
      },
      fetch: (input) => {
        const operationInput = withGitMutationOperationId(input);
        return transport.request((client) => client[WS_METHODS.gitFetch](operationInput));
      },
      discardChanges: (input) => {
        const operationInput = withGitMutationOperationId(input);
        return transport.request((client) => client[WS_METHODS.gitDiscardChanges](operationInput));
      },
      resolvePullRequest: (input) =>
        transport.request((client) => client[WS_METHODS.gitResolvePullRequest](input)),
      preparePullRequestThread: (input) => {
        const operationInput = withGitMutationOperationId(input);
        return transport.request((client) =>
          client[WS_METHODS.gitPreparePullRequestThread](operationInput),
        );
      },
    },
    server: {
      ping: () => transport.request((client) => client[WS_METHODS.serverPing]({})),
      getConfig: () => requestServerConfig(transport),
      refreshProviders: () =>
        transport.request((client) => client[WS_METHODS.serverRefreshProviders]({})),
      refreshUsageLimits: () =>
        transport.request((client) => client[WS_METHODS.serverRefreshUsageLimits]({})),
      activateCliProxy: () =>
        transport.request((client) => client[WS_METHODS.serverActivateCliProxy]({})),
      verifyExecutionTarget: (input) =>
        transport.request((client) => client[WS_METHODS.serverVerifyExecutionTarget](input)),
      listSshConfigHosts: (input) => requestSshConfigHosts(transport, input),
      listRemoteFolders: (input) => requestRemoteFolders(transport, input),
      installRemoteAgent: (input) =>
        transport.request((client) => client[WS_METHODS.serverInstallRemoteAgent](input)),
      connectRemoteAgent: (input) =>
        transport.request((client) => client[WS_METHODS.serverConnectRemoteAgent](input)),
      restartRemoteAgent: (input) =>
        transport.request((client) => client[WS_METHODS.serverRestartRemoteAgent](input)),
      getRemoteAgentRestartStatus: (input) =>
        transport.request((client) => client[WS_METHODS.serverGetRemoteAgentRestartStatus](input)),
      getRemoteAgentUpdateStatus: (input) =>
        transport.request((client) => client[WS_METHODS.serverGetRemoteAgentUpdateStatus](input)),
      unlockSshKey: (input) =>
        transport.request((client) => client[WS_METHODS.serverUnlockSshKey](input)),
      unlockSshPassword: (input) =>
        transport.request((client) => client[WS_METHODS.serverUnlockSshPassword](input)),
      trustSshHost: (input) =>
        transport.request((client) => client[WS_METHODS.serverTrustSshHost](input)),
      upsertKeybinding: (input) =>
        transport.request((client) => client[WS_METHODS.serverUpsertKeybinding](input)),
      getSettings: () => transport.request((client) => client[WS_METHODS.serverGetSettings]({})),
      updateSettings: (patch) =>
        transport.request((client) => client[WS_METHODS.serverUpdateSettings]({ patch })),
      previewThreadRetention: (input) =>
        transport.request((client) => client[WS_METHODS.serverPreviewThreadRetention](input)),
      startThreadRetention: (input) =>
        transport.request((client) => client[WS_METHODS.serverStartThreadRetention](input)),
      getThreadRetentionRun: (input) =>
        transport.request((client) => client[WS_METHODS.serverGetThreadRetentionRun](input)),
      listThreadRetentionRuns: (input) =>
        transport.request((client) => client[WS_METHODS.serverListThreadRetentionRuns](input)),
      setThreadRetentionPolicy: (input) =>
        transport.request((client) => client[WS_METHODS.serverSetThreadRetentionPolicy](input)),
      setThreadPinned: (input) =>
        transport.request((client) => client[WS_METHODS.serverSetThreadPinned](input)),
      readDocumentUrl: (input) =>
        transport.request((client) => client[WS_METHODS.serverReadDocumentUrl](input)),
      writeHandoffDocument: (input) =>
        transport.request((client) => client[WS_METHODS.serverWriteHandoffDocument](input)),
      retryTextGeneration: (input) =>
        transport.request((client) => client[WS_METHODS.serverRetryTextGeneration](input)),
      startHandoffJob: (input) =>
        transport.request((client) => client[WS_METHODS.serverStartHandoffJob](input)),
      getHandoffJob: (input) =>
        transport.request((client) => client[WS_METHODS.serverGetHandoffJob](input)),
      getOpencodeV2ThreadToolsSetup: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverGetOpencodeV2ThreadToolsSetup](input),
        ),
      createMobileRemotePairing: (input) =>
        transport.request((client) => client[WS_METHODS.serverCreateMobileRemotePairing](input)),
      listMobileRemoteSessions: () =>
        transport.request((client) => client[WS_METHODS.serverListMobileRemoteSessions]({})),
      revokeMobileRemoteSession: (input) =>
        transport.request((client) => client[WS_METHODS.serverRevokeMobileRemoteSession](input)),
      exportThreadContext: (input) =>
        transport.request((client) => client[WS_METHODS.serverExportThreadContext](input)),
      getAutomation: (input) =>
        transport.request((client) => client[WS_METHODS.serverGetAutomation](input)),
      listAutomations: (input) =>
        transport.request((client) => client[WS_METHODS.serverListAutomations](input)),
      listAllAutomations: (input = {}) =>
        transport.request((client) => client[WS_METHODS.serverListAllAutomations](input)),
      createAutomation: (input) =>
        transport.request((client) => client[WS_METHODS.serverCreateAutomation](input)),
      createOwnedAutomation: (input) =>
        transport.request((client) => client[WS_METHODS.serverCreateOwnedAutomation](input)),
      updateAutomation: (input) =>
        transport.request((client) => client[WS_METHODS.serverUpdateAutomation](input)),
      pauseAutomation: (input) =>
        transport.request((client) => client[WS_METHODS.serverPauseAutomation](input)),
      resumeAutomation: (input) =>
        transport.request((client) => client[WS_METHODS.serverResumeAutomation](input)),
      deleteAutomation: (input) =>
        transport.request((client) => client[WS_METHODS.serverDeleteAutomation](input)),
      triggerAutomation: (input) =>
        transport.request((client) => client[WS_METHODS.serverTriggerAutomation](input)),
      listAutomationRuns: (input) =>
        transport.request((client) => client[WS_METHODS.serverListAutomationRuns](input)),
      getUsageSummary: (input) =>
        transport.request((client) => client[WS_METHODS.serverGetUsageSummary](input)),
      getWsConnectionDiagnostics: (input) => requestWsConnectionDiagnostics(transport, input),
      stopSubagent: (input) =>
        transport.request((client) => client[WS_METHODS.providerStopSubagent](input)),
      subscribeConfig: (listener, options) =>
        subscribeEmptyInput(
          transport,
          (client) => client[WS_METHODS.subscribeServerConfig],
          listener,
          options,
        ),
      subscribeLifecycle: (listener, options) =>
        subscribeEmptyInput(
          transport,
          (client) => client[WS_METHODS.subscribeServerLifecycle],
          listener,
          options,
        ),
    },
    orchestration: {
      getSidebarThreadCatalog: () =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getSidebarThreadCatalog]({})),
      getStartupProjectCatalog: (input) =>
        transport.request((client) =>
          client[ORCHESTRATION_WS_METHODS.getStartupProjectCatalog](input),
        ),
      searchConversationMessages: (input) =>
        transport.request((client) =>
          client[ORCHESTRATION_WS_METHODS.searchConversationMessages](input),
        ),
      getProjectThreadSummaries: (input) =>
        transport.request((client) =>
          client[ORCHESTRATION_WS_METHODS.getProjectThreadSummaries](input),
        ),
      getSelectedThreadDetail: (input) =>
        transport.request((client) =>
          client[ORCHESTRATION_WS_METHODS.getSelectedThreadDetail](input),
        ),
      getThreadOwnership: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getThreadOwnership](input)),
      getCommandOutcome: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getCommandOutcome](input)),
      getSnapshot: () =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getSnapshot]({})),
      dispatchCommand: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.dispatchCommand](input)),
      getTurnDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getTurnDiff](input)),
      getFullThreadDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getFullThreadDiff](input)),
      replayEvents: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.replayEvents](input)),
      acknowledgeDelivery: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.acknowledgeDelivery](input)),
      acknowledgeDeliveryBaseline: (input) =>
        transport.request((client) =>
          client[ORCHESTRATION_WS_METHODS.acknowledgeDeliveryBaseline](input),
        ),
      onDomainEvent: (input, listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeOrchestrationDomainEvents](input()),
          listener,
          options,
        ),
      onThinkingDelta: (listener, options) =>
        subscribeEmptyInput(
          transport,
          (client) => client[WS_METHODS.subscribeThinkingActivityDeltas],
          listener,
          options,
        ),
    },
  };
}

export type {
  GitRunStackedActionOptions,
  RpcStreamMethod,
  RpcUnaryMethod,
  RpcUnaryNoArgMethod,
  StreamSubscriptionOptions,
  WsRpcClient,
} from "./wsRpcClient.types";
