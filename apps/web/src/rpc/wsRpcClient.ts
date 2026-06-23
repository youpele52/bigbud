import {
  type KanbanCard,
  type KanbanCreateInput,
  type KanbanDeleteInput,
  type KanbanDeleteResult,
  type KanbanGetInput,
  type KanbanListInput,
  type KanbanListResult,
  type KanbanMoveInput,
  type KanbanReorderInput,
  type KanbanUpdateInput,
  type ServerGetAutomationInput,
  type ServerGetAutomationResult,
  type ServerAutomationResult,
  type ServerCreateAutomationInput,
  type ServerDeleteAutomationInput,
  type ServerListAutomationRunsInput,
  type ServerListAutomationRunsResult,
  type ServerListAllAutomationsInput,
  type ServerListAllAutomationsResult,
  type ServerListAutomationsInput,
  type ServerListAutomationsResult,
  type ServerPauseAutomationInput,
  type GitActionProgressEvent,
  type GitGetCommitDetailsInput,
  type GitGetCommitDetailsResult,
  type GitListCommitsInput,
  type GitListCommitsResult,
  type Note,
  type NotesCreateInput,
  type NotesDeleteInput,
  type NotesDeleteResult,
  type NotesGetInput,
  type NotesListInput,
  type NotesListResult,
  type NotesUpdateInput,
  type TeachListProjectsInput,
  type TeachListProjectsResult,
  type ProjectDirectoryWatchEvent,
  type ProjectDirectoryWatchInput,
  type GitReadWorkingTreeDiffInput,
  type GitReadWorkingTreeDiffResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type GitStatusInput,
  type GitStatusStreamEvent,
  type NativeApi,
  ORCHESTRATION_WS_METHODS,
  type ThinkingActivityDeltaEvent,
  type ServerSettingsPatch,
  type ServerResumeAutomationInput,
  type ServerTriggerAutomationInput,
  type ServerTriggerAutomationResult,
  type ServerUpdateAutomationInput,
  type ServerExportThreadContextInput,
  type ServerExportThreadContextResult,
  WS_METHODS,
} from "@bigbud/contracts";
import { Effect, Stream } from "effect";

import { type WsRpcProtocolClient } from "./protocol";
import { resetWsReconnectBackoff } from "./wsConnectionState";
import { WsTransport } from "./wsTransport";

type RpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends RpcTag> = WsRpcProtocolClient[TTag];
type RpcInput<TTag extends RpcTag> = Parameters<RpcMethod<TTag>>[0];

interface StreamSubscriptionOptions {
  readonly onResubscribe?: () => void;
}

type RpcUnaryMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? (input: RpcInput<TTag>) => Promise<TSuccess>
    : never;

type RpcUnaryNoArgMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? () => Promise<TSuccess>
    : never;

type RpcStreamMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer TEvent, any, any>
    ? (listener: (event: TEvent) => void, options?: StreamSubscriptionOptions) => () => void
    : never;

interface GitRunStackedActionOptions {
  readonly onProgress?: (event: GitActionProgressEvent) => void;
}

export interface WsRpcClient {
  readonly dispose: () => Promise<void>;
  readonly reconnect: () => Promise<void>;
  readonly terminal: {
    readonly open: RpcUnaryMethod<typeof WS_METHODS.terminalOpen>;
    readonly write: RpcUnaryMethod<typeof WS_METHODS.terminalWrite>;
    readonly resize: RpcUnaryMethod<typeof WS_METHODS.terminalResize>;
    readonly clear: RpcUnaryMethod<typeof WS_METHODS.terminalClear>;
    readonly restart: RpcUnaryMethod<typeof WS_METHODS.terminalRestart>;
    readonly close: RpcUnaryMethod<typeof WS_METHODS.terminalClose>;
    readonly onEvent: RpcStreamMethod<typeof WS_METHODS.subscribeTerminalEvents>;
  };
  readonly projects: {
    readonly listDirectory: RpcUnaryMethod<typeof WS_METHODS.projectsListDirectory>;
    readonly onDirectoryChange: (
      input: ProjectDirectoryWatchInput,
      listener: (event: ProjectDirectoryWatchEvent) => void,
      options?: StreamSubscriptionOptions,
    ) => () => void;
    readonly readFilePreview: RpcUnaryMethod<typeof WS_METHODS.projectsReadFilePreview>;
    readonly searchFileContents: RpcUnaryMethod<typeof WS_METHODS.projectsSearchFileContents>;
    readonly searchEntries: RpcUnaryMethod<typeof WS_METHODS.projectsSearchEntries>;
    readonly writeFile: RpcUnaryMethod<typeof WS_METHODS.projectsWriteFile>;
  };
  readonly notes: {
    readonly list: (input: NotesListInput) => Promise<NotesListResult>;
    readonly get: (input: NotesGetInput) => Promise<Note>;
    readonly create: (input: NotesCreateInput) => Promise<Note>;
    readonly update: (input: NotesUpdateInput) => Promise<Note>;
    readonly delete: (input: NotesDeleteInput) => Promise<NotesDeleteResult>;
  };
  readonly kanban: {
    readonly list: (input: KanbanListInput) => Promise<KanbanListResult>;
    readonly get: (input: KanbanGetInput) => Promise<KanbanCard>;
    readonly create: (input: KanbanCreateInput) => Promise<KanbanCard>;
    readonly update: (input: KanbanUpdateInput) => Promise<KanbanCard>;
    readonly delete: (input: KanbanDeleteInput) => Promise<KanbanDeleteResult>;
    readonly move: (input: KanbanMoveInput) => Promise<KanbanCard>;
    readonly reorder: (input: KanbanReorderInput) => Promise<KanbanCard>;
  };
  readonly teach: {
    readonly listProjects: (input: TeachListProjectsInput) => Promise<TeachListProjectsResult>;
  };
  readonly shell: {
    readonly openInEditor: (input: {
      readonly cwd: Parameters<NativeApi["shell"]["openInEditor"]>[0];
      readonly editor: Parameters<NativeApi["shell"]["openInEditor"]>[1];
    }) => ReturnType<NativeApi["shell"]["openInEditor"]>;
    readonly openPath: (input: {
      readonly path: Parameters<NativeApi["shell"]["openPath"]>[0];
    }) => ReturnType<NativeApi["shell"]["openPath"]>;
  };
  readonly git: {
    readonly pull: RpcUnaryMethod<typeof WS_METHODS.gitPull>;
    readonly refreshStatus: RpcUnaryMethod<typeof WS_METHODS.gitRefreshStatus>;
    readonly listCommits: (input: GitListCommitsInput) => Promise<GitListCommitsResult>;
    readonly getCommitDetails: (
      input: GitGetCommitDetailsInput,
    ) => Promise<GitGetCommitDetailsResult>;
    readonly readWorkingTreeDiff: (
      input: GitReadWorkingTreeDiffInput,
    ) => Promise<GitReadWorkingTreeDiffResult>;
    readonly onStatus: (
      input: GitStatusInput,
      listener: (event: GitStatusStreamEvent) => void,
    ) => () => void;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitRunStackedActionOptions,
    ) => Promise<GitRunStackedActionResult>;
    readonly listBranches: RpcUnaryMethod<typeof WS_METHODS.gitListBranches>;
    readonly createWorktree: RpcUnaryMethod<typeof WS_METHODS.gitCreateWorktree>;
    readonly removeWorktree: RpcUnaryMethod<typeof WS_METHODS.gitRemoveWorktree>;
    readonly createBranch: RpcUnaryMethod<typeof WS_METHODS.gitCreateBranch>;
    readonly checkout: RpcUnaryMethod<typeof WS_METHODS.gitCheckout>;
    readonly init: RpcUnaryMethod<typeof WS_METHODS.gitInit>;
    readonly fetch: RpcUnaryMethod<typeof WS_METHODS.gitFetch>;
    readonly discardChanges: RpcUnaryMethod<typeof WS_METHODS.gitDiscardChanges>;
    readonly resolvePullRequest: RpcUnaryMethod<typeof WS_METHODS.gitResolvePullRequest>;
    readonly preparePullRequestThread: RpcUnaryMethod<
      typeof WS_METHODS.gitPreparePullRequestThread
    >;
  };
  readonly server: {
    readonly getConfig: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetConfig>;
    readonly refreshProviders: RpcUnaryNoArgMethod<typeof WS_METHODS.serverRefreshProviders>;
    readonly verifyExecutionTarget: RpcUnaryMethod<typeof WS_METHODS.serverVerifyExecutionTarget>;
    readonly unlockSshKey: RpcUnaryMethod<typeof WS_METHODS.serverUnlockSshKey>;
    readonly unlockSshPassword: RpcUnaryMethod<typeof WS_METHODS.serverUnlockSshPassword>;
    readonly upsertKeybinding: RpcUnaryMethod<typeof WS_METHODS.serverUpsertKeybinding>;
    readonly getSettings: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetSettings>;
    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.serverUpdateSettings>>;
    readonly readDocumentUrl: RpcUnaryMethod<typeof WS_METHODS.serverReadDocumentUrl>;
    readonly writeHandoffDocument: RpcUnaryMethod<typeof WS_METHODS.serverWriteHandoffDocument>;
    readonly exportThreadContext: (
      input: ServerExportThreadContextInput,
    ) => Promise<ServerExportThreadContextResult>;
    readonly getAutomation: (input: ServerGetAutomationInput) => Promise<ServerGetAutomationResult>;
    readonly listAutomations: (
      input: ServerListAutomationsInput,
    ) => Promise<ServerListAutomationsResult>;
    readonly listAllAutomations: (
      input?: ServerListAllAutomationsInput,
    ) => Promise<ServerListAllAutomationsResult>;
    readonly createAutomation: (
      input: ServerCreateAutomationInput,
    ) => Promise<ServerAutomationResult>;
    readonly updateAutomation: (
      input: ServerUpdateAutomationInput,
    ) => Promise<ServerAutomationResult>;
    readonly pauseAutomation: (input: ServerPauseAutomationInput) => Promise<void>;
    readonly resumeAutomation: (input: ServerResumeAutomationInput) => Promise<void>;
    readonly deleteAutomation: (input: ServerDeleteAutomationInput) => Promise<void>;
    readonly triggerAutomation: (
      input: ServerTriggerAutomationInput,
    ) => Promise<ServerTriggerAutomationResult>;
    readonly listAutomationRuns: (
      input: ServerListAutomationRunsInput,
    ) => Promise<ServerListAutomationRunsResult>;
    readonly subscribeConfig: RpcStreamMethod<typeof WS_METHODS.subscribeServerConfig>;
    readonly subscribeLifecycle: RpcStreamMethod<typeof WS_METHODS.subscribeServerLifecycle>;
  };
  readonly orchestration: {
    readonly getSnapshot: RpcUnaryNoArgMethod<typeof ORCHESTRATION_WS_METHODS.getSnapshot>;
    readonly dispatchCommand: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.dispatchCommand>;
    readonly getTurnDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getTurnDiff>;
    readonly getFullThreadDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getFullThreadDiff>;
    readonly replayEvents: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.replayEvents>;
    readonly onDomainEvent: RpcStreamMethod<typeof WS_METHODS.subscribeOrchestrationDomainEvents>;
    readonly onThinkingDelta: (
      listener: (event: ThinkingActivityDeltaEvent) => void,
      options?: StreamSubscriptionOptions,
    ) => () => void;
  };
}

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
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeTerminalEvents]({}),
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
      runStackedAction: async (input, options) => {
        let result: GitRunStackedActionResult | null = null;

        await transport.requestStream(
          (client) => client[WS_METHODS.gitRunStackedAction](input),
          (event) => {
            options?.onProgress?.(event);
            if (event.kind === "action_finished") {
              result = event.result;
            }
          },
        );

        if (result) {
          return result;
        }

        throw new Error("Git action stream completed without a final result.");
      },
      listBranches: (input) =>
        transport.request((client) => client[WS_METHODS.gitListBranches](input)),
      createWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.gitCreateWorktree](input)),
      removeWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.gitRemoveWorktree](input)),
      createBranch: (input) =>
        transport.request((client) => client[WS_METHODS.gitCreateBranch](input)),
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
      getConfig: () => transport.request((client) => client[WS_METHODS.serverGetConfig]({})),
      refreshProviders: () =>
        transport.request((client) => client[WS_METHODS.serverRefreshProviders]({})),
      verifyExecutionTarget: (input) =>
        transport.request((client) => client[WS_METHODS.serverVerifyExecutionTarget](input)),
      unlockSshKey: (input) =>
        transport.request((client) => client[WS_METHODS.serverUnlockSshKey](input)),
      unlockSshPassword: (input) =>
        transport.request((client) => client[WS_METHODS.serverUnlockSshPassword](input)),
      upsertKeybinding: (input) =>
        transport.request((client) => client[WS_METHODS.serverUpsertKeybinding](input)),
      getSettings: () => transport.request((client) => client[WS_METHODS.serverGetSettings]({})),
      updateSettings: (patch) =>
        transport.request((client) => client[WS_METHODS.serverUpdateSettings]({ patch })),
      readDocumentUrl: (input) =>
        transport.request((client) => client[WS_METHODS.serverReadDocumentUrl](input)),
      writeHandoffDocument: (input) =>
        transport.request((client) => client[WS_METHODS.serverWriteHandoffDocument](input)),
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
      subscribeConfig: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeServerConfig]({}),
          listener,
          options,
        ),
      subscribeLifecycle: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
          listener,
          options,
        ),
    },
    orchestration: {
      getSnapshot: () =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getSnapshot]({})),
      dispatchCommand: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.dispatchCommand](input)),
      getTurnDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getTurnDiff](input)),
      getFullThreadDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getFullThreadDiff](input)),
      replayEvents: (input) =>
        transport
          .request((client) => client[ORCHESTRATION_WS_METHODS.replayEvents](input))
          .then((events) => [...events]),
      onDomainEvent: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeOrchestrationDomainEvents]({}),
          listener,
          options,
        ),
      onThinkingDelta: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeThinkingActivityDeltas]({}),
          listener,
          options,
        ),
    },
  };
}
