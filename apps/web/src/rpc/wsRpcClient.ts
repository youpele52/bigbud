import {
  type GitRunStackedActionResult,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
} from "@bigbud/contracts";

import { resetWsReconnectBackoff } from "./wsConnectionState";
import { WsTransport } from "./wsTransport";
import {
  type GitRunStackedActionOptions,
  type StreamSubscriptionOptions,
  type WsRpcClient,
} from "./wsRpcClient.types";

let sharedWsRpcClient: WsRpcClient | null = null;

export function getWsRpcClient(): WsRpcClient {
  if (sharedWsRpcClient) {
    return sharedWsRpcClient;
  }
  sharedWsRpcClient = createWsRpcClient();
  return sharedWsRpcClient;
}

export async function __resetWsRpcClientForTests() {
  await sharedWsRpcClient?.dispose();
  sharedWsRpcClient = null;
}

function subscribeEmptyInput<TEvent>(
  transport: WsTransport,
  method: (client: any) => { (_input: {}): any },
  listener: (event: TEvent) => void,
  options?: StreamSubscriptionOptions,
) {
  return transport.subscribe((client) => method(client)({}), listener, options);
}

function runGitStackedAction(
  transport: WsTransport,
  input: Parameters<WsRpcClient["git"]["runStackedAction"]>[0],
  options?: GitRunStackedActionOptions,
) {
  let result: GitRunStackedActionResult | null = null;

  return transport
    .requestStream(
      (client) => client[WS_METHODS.gitRunStackedAction](input),
      (event) => {
        options?.onProgress?.(event);
        if (event.kind === "action_finished") {
          result = event.result;
        }
      },
    )
    .then(() => {
      if (result) {
        return result;
      }
      throw new Error("Git action stream completed without a final result.");
    });
}

export function createWsRpcClient(transport = new WsTransport()): WsRpcClient {
  return {
    dispose: () => transport.dispose(),
    reconnect: async () => {
      resetWsReconnectBackoff();
      await transport.reconnect();
    },
    terminal: {
      open: (input) => transport.request((client) => client[WS_METHODS.terminalOpen](input)),
      write: (input) => transport.request((client) => client[WS_METHODS.terminalWrite](input)),
      resize: (input) => transport.request((client) => client[WS_METHODS.terminalResize](input)),
      clear: (input) => transport.request((client) => client[WS_METHODS.terminalClear](input)),
      restart: (input) => transport.request((client) => client[WS_METHODS.terminalRestart](input)),
      close: (input) => transport.request((client) => client[WS_METHODS.terminalClose](input)),
      onEvent: (listener, options) =>
        subscribeEmptyInput(
          transport,
          (client) => client[WS_METHODS.subscribeTerminalEvents],
          listener,
          options,
        ),
    },
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
      writeFile: (input) =>
        transport.request((client) => client[WS_METHODS.projectsWriteFile](input)),
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
    git: {
      pull: (input) => transport.request((client) => client[WS_METHODS.gitPull](input)),
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
      createWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.gitCreateWorktree](input)),
      removeWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.gitRemoveWorktree](input)),
      createBranch: (input) =>
        transport.request((client) => client[WS_METHODS.gitCreateBranch](input)),
      renameBranch: (input) =>
        transport.request((client) => client[WS_METHODS.gitRenameBranch](input)),
      deleteBranch: (input) =>
        transport.request((client) => client[WS_METHODS.gitDeleteBranch](input)),
      checkout: (input) => transport.request((client) => client[WS_METHODS.gitCheckout](input)),
      init: (input) => transport.request((client) => client[WS_METHODS.gitInit](input)),
      fetch: (input) => transport.request((client) => client[WS_METHODS.gitFetch](input)),
      discardChanges: (input) =>
        transport.request((client) => client[WS_METHODS.gitDiscardChanges](input)),
      resolvePullRequest: (input) =>
        transport.request((client) => client[WS_METHODS.gitResolvePullRequest](input)),
      preparePullRequestThread: (input) =>
        transport.request((client) => client[WS_METHODS.gitPreparePullRequestThread](input)),
    },
    server: {
      ping: () => transport.request((client) => client[WS_METHODS.serverPing]({})),
      getConfig: () => transport.request((client) => client[WS_METHODS.serverGetConfig]({})),
      refreshProviders: () =>
        transport.request((client) => client[WS_METHODS.serverRefreshProviders]({})),
      activateCliProxy: () =>
        transport.request((client) => client[WS_METHODS.serverActivateCliProxy]({})),
      verifyExecutionTarget: (input) =>
        transport.request((client) => client[WS_METHODS.serverVerifyExecutionTarget](input)),
      installRemoteAgent: (input) =>
        transport.request((client) => client[WS_METHODS.serverInstallRemoteAgent](input)),
      unlockSshKey: (input) =>
        transport.request((client) => client[WS_METHODS.serverUnlockSshKey](input)),
      unlockSshPassword: (input) =>
        transport.request((client) => client[WS_METHODS.serverUnlockSshPassword](input)),
      upsertKeybinding: (input) =>
        transport.request((client) => client[WS_METHODS.serverUpsertKeybinding](input)),
      getSettings: () => transport.request((client) => client[WS_METHODS.serverGetSettings]({})),
      updateSettings: (patch) =>
        transport.request((client) => client[WS_METHODS.serverUpdateSettings]({ patch })),
      previewThreadRetention: (input) =>
        transport.request((client) => client[WS_METHODS.serverPreviewThreadRetention](input)),
      startThreadRetention: (input) =>
        transport.request((client) => client[WS_METHODS.serverStartThreadRetention](input)),
      setThreadRetentionPolicy: (input) =>
        transport.request((client) => client[WS_METHODS.serverSetThreadRetentionPolicy](input)),
      setThreadPinned: (input) =>
        transport.request((client) => client[WS_METHODS.serverSetThreadPinned](input)),
      readDocumentUrl: (input) =>
        transport.request((client) => client[WS_METHODS.serverReadDocumentUrl](input)),
      writeHandoffDocument: (input) =>
        transport.request((client) => client[WS_METHODS.serverWriteHandoffDocument](input)),
      startHandoffJob: (input) =>
        transport.request((client) => client[WS_METHODS.serverStartHandoffJob](input)),
      getHandoffJob: (input) =>
        transport.request((client) => client[WS_METHODS.serverGetHandoffJob](input)),
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
