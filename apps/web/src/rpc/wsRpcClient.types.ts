import {
  type GitActionProgressEvent,
  type GitGetCommitDetailsInput,
  type GitGetCommitDetailsResult,
  type GitListCommitsInput,
  type GitListCommitsResult,
  type GitReadWorkingTreeDiffInput,
  type GitReadWorkingTreeDiffResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type GitStatusInput,
  type GitStatusStreamEvent,
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
  type NativeApi,
  type Note,
  type NotesCreateInput,
  type NotesDeleteInput,
  type NotesDeleteResult,
  type NotesGetInput,
  type NotesListInput,
  type NotesListResult,
  type NotesUpdateInput,
  ORCHESTRATION_WS_METHODS,
  type ProjectDirectoryWatchEvent,
  type ProjectDirectoryWatchInput,
  type ServerAutomationResult,
  type ServerCreateAutomationInput,
  type ServerCreateMobileRemotePairingInput,
  type ServerDeleteAutomationInput,
  type ServerExportThreadContextInput,
  type ServerExportThreadContextResult,
  type ServerGetHandoffJobInput,
  type ServerHandoffJob,
  type ServerGetAutomationInput,
  type ServerGetAutomationResult,
  type ServerListAllAutomationsInput,
  type ServerListAllAutomationsResult,
  type ServerListAutomationRunsInput,
  type ServerListAutomationRunsResult,
  type ServerListAutomationsInput,
  type ServerListAutomationsResult,
  type ServerListMobileRemoteSessionsResult,
  type ServerMobileRemotePairing,
  type ServerPauseAutomationInput,
  type ServerResumeAutomationInput,
  type ServerRevokeMobileRemoteSessionInput,
  type ServerSettingsPatch,
  type ServerStartHandoffJobInput,
  type ServerTriggerAutomationInput,
  type ServerTriggerAutomationResult,
  type ServerUpdateAutomationInput,
  type TeachListProjectsInput,
  type TeachListProjectsResult,
  type ThinkingActivityDeltaEvent,
  WS_METHODS,
} from "@bigbud/contracts";
import { Effect, Stream } from "effect";

import type { WsRpcProtocolClient } from "./protocol";

export type RpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends RpcTag> = WsRpcProtocolClient[TTag];
type RpcInput<TTag extends RpcTag> = Parameters<RpcMethod<TTag>>[0];

export interface StreamSubscriptionOptions {
  readonly onResubscribe?: () => void;
}

export type RpcUnaryMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? (input: RpcInput<TTag>) => Promise<TSuccess>
    : never;

export type RpcUnaryNoArgMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? () => Promise<TSuccess>
    : never;

export type RpcStreamMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer TEvent, any, any>
    ? (listener: (event: TEvent) => void, options?: StreamSubscriptionOptions) => () => void
    : never;

export interface GitRunStackedActionOptions {
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
    readonly startHandoffJob: (input: ServerStartHandoffJobInput) => Promise<ServerHandoffJob>;
    readonly getHandoffJob: (input: ServerGetHandoffJobInput) => Promise<ServerHandoffJob>;
    readonly createMobileRemotePairing: (
      input: ServerCreateMobileRemotePairingInput,
    ) => Promise<ServerMobileRemotePairing>;
    readonly listMobileRemoteSessions: () => Promise<ServerListMobileRemoteSessionsResult>;
    readonly revokeMobileRemoteSession: (
      input: ServerRevokeMobileRemoteSessionInput,
    ) => Promise<void>;
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
