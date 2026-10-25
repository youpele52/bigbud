import type { ServerSettings, ServerSettingsPatch } from "../core/settings";
import type { ServerTrustSshHostInput, ServerTrustSshHostResult } from "./server.sshHostTrust";
import type {
  ClientOrchestrationCommand,
  GetCommandOutcomeInput,
  GetCommandOutcomeResult,
  GetProjectThreadSummariesInput,
  GetProjectThreadSummariesResult,
  GetSelectedThreadDetailInput,
  GetSelectedThreadDetailResult,
  GetThreadOwnershipInput,
  GetThreadOwnershipResult,
  GetSidebarThreadCatalogResult,
  GetStartupProjectCatalogInput,
  GetStartupProjectCatalogResult,
  SearchConversationMessagesInput,
  SearchConversationMessagesResult,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationApplicationAckInput,
  OrchestrationApplicationAckResult,
  OrchestrationBaselineAckInput,
  OrchestrationBaselineAckResult,
  OrchestrationDeliveryStreamItem,
  OrchestrationReadModel,
  OrchestrationReplayEventsResult,
  ThinkingActivityDeltaEvent,
} from "../orchestration/orchestration";
import type { EditorId } from "../workspace/editor";
import type { TerminalApplicationId } from "../workspace/terminalApplication";
import type * as Git from "../workspace/git";
import type * as Worktrees from "../workspace/worktrees";
import type * as Project from "../workspace/project";
import type * as Terminal from "../workspace/terminal";
import type * as TerminalStream from "../workspace/terminal.stream";
import type * as TerminalSearch from "../workspace/terminal.search";
import type { TerminalWslDistributions } from "../workspace/terminal.wsl";
import type * as Automation from "./automation";
import type * as ConnectionDiagnostics from "./connectionDiagnostics";
import type { ContextMenuItem } from "./ipc";
import type * as Kanban from "./kanban";
import type * as Mobile from "./mobile";
import type * as Notes from "./notes";
import type * as PinnedThreads from "./pinnedThreads";
import type * as Server from "./server";
import type * as RemoteRestart from "./server.remoteRestart";
import type * as SshConfig from "./server.sshConfig";
import type * as RemoteFolders from "./server.remoteFolders";
import type * as Handoff from "./server.handoff";
import type * as Retention from "./threadRetention";
import type * as Teach from "./teach";
import type * as Subagents from "./subagents";
import type * as Usage from "./usage";

export interface NativeApi {
  worktrees?: {
    operations: (
      input: Worktrees.WorktreeContext,
    ) => Promise<readonly Worktrees.WorktreeOperationSummary[]>;
    recover: (
      input: Worktrees.WorktreeOperationRecovery,
    ) => Promise<Worktrees.WorktreeOperationSummary>;
    list: (input: Worktrees.WorktreeContext) => Promise<Worktrees.WorktreeInventory>;
    create: (input: Worktrees.WorktreeCreate) => Promise<{ path: string; branch: string }>;
    delete: (input: Worktrees.WorktreeMutation) => Promise<Worktrees.WorktreeOperationResult>;
    select: (input: Worktrees.WorktreeSelection) => Promise<void>;
  };
  dialogs: {
    pickFolder: () => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  fileAccess: {
    request: (
      level: "unrestricted" | "common-folders",
    ) => Promise<{ success: boolean; granted: string[]; denied: string[] }>;
  };
  terminal: {
    wslDistributions?: () => Promise<TerminalWslDistributions>;
    snapshot?: (
      input: typeof Terminal.TerminalSnapshotInput.Encoded,
    ) => Promise<Terminal.TerminalSessionSnapshot>;
    open: (
      input: typeof Terminal.TerminalOpenInput.Encoded,
    ) => Promise<Terminal.TerminalSessionSnapshot>;
    write: (input: typeof Terminal.TerminalWriteInput.Encoded) => Promise<void>;
    resize: (input: typeof Terminal.TerminalResizeInput.Encoded) => Promise<void>;
    clear: (input: typeof Terminal.TerminalClearInput.Encoded) => Promise<void>;
    restart: (
      input: typeof Terminal.TerminalRestartInput.Encoded,
    ) => Promise<Terminal.TerminalSessionSnapshot>;
    close: (input: typeof Terminal.TerminalCloseInput.Encoded) => Promise<void>;
    /** Sidebar/agent state; output only for sessions whose agent detection runs in the client. */
    onEvent: (callback: (event: Terminal.TerminalEvent) => void) => () => void;
    /** One terminal's events for a mounted view, flow-controlled by `ackOutput`. */
    subscribeSession?: (
      input: TerminalStream.TerminalSessionStreamInput,
      callback: (item: TerminalStream.TerminalSessionStreamItem) => void,
      options?: { onError?: (error: unknown) => void },
    ) => () => void;
    ackOutput?: (input: TerminalStream.TerminalOutputAckInput) => Promise<void>;
    /** Retained output of the server's terminals, newest lines first. */
    search?: (
      input: TerminalSearch.TerminalSearchInput,
    ) => Promise<TerminalSearch.TerminalSearchResult>;
  };
  projects: {
    listDirectory: (
      input: Project.ProjectListDirectoryInput,
    ) => Promise<Project.ProjectListDirectoryResult>;
    onDirectoryChange: (
      input: Project.ProjectDirectoryWatchInput,
      callback: (event: Project.ProjectDirectoryWatchEvent) => void,
      options?: {
        onError?: (error: unknown) => void;
        onResubscribe?: () => void;
        shouldRetry?: (error: unknown) => boolean;
      },
    ) => () => void;
    readFilePreview: (
      input: Project.ProjectReadFilePreviewInput,
    ) => Promise<Project.ProjectReadFilePreviewResult>;
    searchFileContents: (
      input: Project.ProjectSearchFileContentsInput,
    ) => Promise<Project.ProjectSearchFileContentsResult>;
    searchEntries: (
      input: Project.ProjectSearchEntriesInput,
    ) => Promise<Project.ProjectSearchEntriesResult>;
    writeFile: (input: Project.ProjectWriteFileInput) => Promise<Project.ProjectWriteFileResult>;
  };
  notes: {
    list: (input: Notes.NotesListInput) => Promise<Notes.NotesListResult>;
    get: (input: Notes.NotesGetInput) => Promise<Notes.Note>;
    create: (input: Notes.NotesCreateInput) => Promise<Notes.Note>;
    update: (input: Notes.NotesUpdateInput) => Promise<Notes.Note>;
    delete: (input: Notes.NotesDeleteInput) => Promise<Notes.NotesDeleteResult>;
  };
  kanban: {
    list: (input: Kanban.KanbanListInput) => Promise<Kanban.KanbanListResult>;
    get: (input: Kanban.KanbanGetInput) => Promise<Kanban.KanbanCard>;
    create: (input: Kanban.KanbanCreateInput) => Promise<Kanban.KanbanCard>;
    update: (input: Kanban.KanbanUpdateInput) => Promise<Kanban.KanbanCard>;
    delete: (input: Kanban.KanbanDeleteInput) => Promise<Kanban.KanbanDeleteResult>;
    move: (input: Kanban.KanbanMoveInput) => Promise<Kanban.KanbanCard>;
    reorder: (input: Kanban.KanbanReorderInput) => Promise<Kanban.KanbanCard>;
  };
  teach: {
    listProjects: (input?: Teach.TeachListProjectsInput) => Promise<Teach.TeachListProjectsResult>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    openInTerminal: (cwd: string, terminal: TerminalApplicationId) => Promise<void>;
    openPath: (path: string) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
  git: {
    listBranches: (input: Git.GitListBranchesInput) => Promise<Git.GitListBranchesResult>;
    listCommits: (input: Git.GitListCommitsInput) => Promise<Git.GitListCommitsResult>;
    getCommitDetails: (
      input: Git.GitGetCommitDetailsInput,
    ) => Promise<Git.GitGetCommitDetailsResult>;
    readWorkingTreeDiff: (
      input: Git.GitReadWorkingTreeDiffInput,
    ) => Promise<Git.GitReadWorkingTreeDiffResult>;
    createWorktree: (input: Git.GitCreateWorktreeInput) => Promise<Git.GitCreateWorktreeResult>;
    removeWorktree: (input: Git.GitRemoveWorktreeInput) => Promise<void>;
    createBranch: (input: Git.GitCreateBranchInput) => Promise<Git.GitCreateBranchResult>;
    renameBranch: (input: Git.GitRenameBranchInput) => Promise<Git.GitRenameBranchResult>;
    deleteBranch: (input: Git.GitDeleteBranchInput) => Promise<void>;
    checkout: (input: Git.GitCheckoutInput) => Promise<Git.GitCheckoutResult>;
    init: (input: Git.GitInitInput) => Promise<void>;
    resolvePullRequest: (
      input: Git.GitPullRequestRefInput,
    ) => Promise<Git.GitResolvePullRequestResult>;
    preparePullRequestThread: (
      input: Git.GitPreparePullRequestThreadInput,
    ) => Promise<Git.GitPreparePullRequestThreadResult>;
    pull: (input: Git.GitPullInput) => Promise<Git.GitPullResult>;
    fetch: (input: Git.GitFetchInput) => Promise<Git.GitFetchResult>;
    discardChanges: (input: Git.GitDiscardChangesInput) => Promise<void>;
    refreshStatus: (input: Git.GitStatusInput) => Promise<Git.GitStatusResult>;
    onStatus: (
      input: Git.GitStatusInput,
      callback: (event: Git.GitStatusStreamEvent) => void,
    ) => () => void;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  server: {
    getConfig: () => Promise<Server.ServerConfig>;
    refreshProviders: () => Promise<Server.ServerProviderUpdatedPayload>;
    refreshUsageLimits: () => Promise<Server.ServerProviderUpdatedPayload>;
    activateCliProxy: () => Promise<Server.ServerProviderUpdatedPayload>;
    verifyExecutionTarget: (
      input: Server.ServerVerifyExecutionTargetInput,
    ) => Promise<Server.ServerVerifyExecutionTargetResult>;
    listSshConfigHosts: (
      input: SshConfig.ServerListSshConfigHostsInput,
    ) => Promise<SshConfig.ServerListSshConfigHostsResult>;
    listRemoteFolders: (
      input: RemoteFolders.ServerListRemoteFoldersInput,
    ) => Promise<RemoteFolders.ServerListRemoteFoldersResult>;
    installRemoteAgent: (
      input: Server.ServerInstallRemoteAgentInput,
    ) => Promise<Server.ServerInstallRemoteAgentResult>;
    connectRemoteAgent: (
      input: Server.ServerConnectRemoteAgentInput,
    ) => Promise<Server.ServerConnectRemoteAgentResult>;
    restartRemoteAgent: (
      input: RemoteRestart.ServerRestartRemoteAgentInput,
    ) => Promise<RemoteRestart.ServerRestartRemoteAgentResult>;
    getRemoteAgentRestartStatus: (
      input: RemoteRestart.ServerGetRemoteAgentRestartStatusInput,
    ) => Promise<RemoteRestart.ServerRestartRemoteAgentResult>;
    getRemoteAgentUpdateStatus: (
      input: Server.ServerGetRemoteAgentUpdateStatusInput,
    ) => Promise<Server.ServerRemoteAgentUpdateStatus>;
    unlockSshKey: (
      input: Server.ServerUnlockSshKeyInput,
    ) => Promise<Server.ServerUnlockSshKeyResult>;
    unlockSshPassword: (
      input: Server.ServerUnlockSshPasswordInput,
    ) => Promise<Server.ServerUnlockSshPasswordResult>;
    trustSshHost: (input: ServerTrustSshHostInput) => Promise<ServerTrustSshHostResult>;
    upsertKeybinding: (
      input: Server.ServerUpsertKeybindingInput,
    ) => Promise<Server.ServerUpsertKeybindingResult>;
    getSettings: () => Promise<ServerSettings>;
    updateSettings: (patch: ServerSettingsPatch) => Promise<ServerSettings>;
    previewThreadRetention: (
      input: Retention.ServerPreviewThreadRetentionInput,
    ) => Promise<Retention.ServerThreadRetentionPreview>;
    startThreadRetention: (
      input: Retention.ServerStartThreadRetentionInput,
    ) => Promise<Retention.ServerThreadRetentionRun>;
    getThreadRetentionRun: (
      input: Retention.ServerGetThreadRetentionRunInput,
    ) => Promise<Retention.ServerThreadRetentionRun>;
    listThreadRetentionRuns: (
      input: Retention.ServerListThreadRetentionRunsInput,
    ) => Promise<Retention.ServerListThreadRetentionRunsResult>;
    setThreadRetentionPolicy: (
      input: Retention.ServerSetThreadRetentionPolicyInput,
    ) => Promise<ServerSettings>;
    setThreadPinned: (
      input: PinnedThreads.ServerSetThreadPinnedInput,
    ) => Promise<PinnedThreads.ServerSetThreadPinnedResult>;
    readDocumentUrl: (
      input: Server.ServerReadDocumentUrlInput,
    ) => Promise<Server.ServerReadDocumentUrlResult>;
    writeHandoffDocument: (
      input: Server.ServerWriteHandoffDocumentInput,
    ) => Promise<Server.ServerWriteHandoffDocumentResult>;
    retryTextGeneration: (
      input: import("./rpc.textGeneration").RetryThreadTextGenerationInput,
    ) => Promise<void>;
    startHandoffJob: (
      input: Handoff.ServerStartHandoffJobInput,
    ) => Promise<Handoff.ServerHandoffJob>;
    getHandoffJob: (input: Handoff.ServerGetHandoffJobInput) => Promise<Handoff.ServerHandoffJob>;
    getOpencodeV2ThreadToolsSetup: (
      input: ServerOpencodeV2ThreadToolsSetupInput,
    ) => Promise<ServerOpencodeV2ThreadToolsSetupResult>;
    createMobileRemotePairing: (
      input: Mobile.ServerCreateMobileRemotePairingInput,
    ) => Promise<Mobile.ServerMobileRemotePairing>;
    listMobileRemoteSessions: () => Promise<Mobile.ServerListMobileRemoteSessionsResult>;
    revokeMobileRemoteSession: (
      input: Mobile.ServerRevokeMobileRemoteSessionInput,
    ) => Promise<void>;
    exportThreadContext: (
      input: Server.ServerExportThreadContextInput,
    ) => Promise<Server.ServerExportThreadContextResult>;
    getAutomation: (
      input: Automation.ServerGetAutomationInput,
    ) => Promise<Automation.ServerGetAutomationResult>;
    listAutomations: (
      input: Automation.ServerListAutomationsInput,
    ) => Promise<Automation.ServerListAutomationsResult>;
    listAllAutomations: (
      input?: Automation.ServerListAllAutomationsInput,
    ) => Promise<Automation.ServerListAllAutomationsResult>;
    createAutomation: (
      input: Automation.ServerCreateAutomationInput,
    ) => Promise<Automation.ServerAutomationResult>;
    createOwnedAutomation: (
      input: Automation.ServerCreateOwnedAutomationInput,
    ) => Promise<Automation.ServerAutomationResult>;
    updateAutomation: (
      input: Automation.ServerUpdateAutomationInput,
    ) => Promise<Automation.ServerAutomationResult>;
    pauseAutomation: (input: Automation.ServerPauseAutomationInput) => Promise<void>;
    resumeAutomation: (input: Automation.ServerResumeAutomationInput) => Promise<void>;
    deleteAutomation: (input: Automation.ServerDeleteAutomationInput) => Promise<void>;
    triggerAutomation: (
      input: Automation.ServerTriggerAutomationInput,
    ) => Promise<Automation.ServerTriggerAutomationResult>;
    listAutomationRuns: (
      input: Automation.ServerListAutomationRunsInput,
    ) => Promise<Automation.ServerListAutomationRunsResult>;
    getUsageSummary: (
      input: Usage.ServerGetUsageSummaryInput,
    ) => Promise<Usage.ServerUsageSummaryResult>;
    /** Stop one running provider subagent; Stop-all is unchanged. */
    stopSubagent: (input: Subagents.ProviderStopSubagentInput) => Promise<void>;
    /** Recent connection reports and server stalls; optional until every transport wires it. */
    getWsConnectionDiagnostics?: (
      input: ConnectionDiagnostics.ServerGetWsConnectionDiagnosticsInput,
    ) => Promise<ConnectionDiagnostics.ServerWsConnectionDiagnosticsSnapshot>;
  };
  orchestration: {
    getSidebarThreadCatalog: () => Promise<GetSidebarThreadCatalogResult>;
    getStartupProjectCatalog: (
      input: GetStartupProjectCatalogInput,
    ) => Promise<GetStartupProjectCatalogResult>;
    searchConversationMessages: (
      input: SearchConversationMessagesInput,
    ) => Promise<SearchConversationMessagesResult>;
    getProjectThreadSummaries: (
      input: GetProjectThreadSummariesInput,
    ) => Promise<GetProjectThreadSummariesResult>;
    getSelectedThreadDetail: (
      input: GetSelectedThreadDetailInput,
    ) => Promise<GetSelectedThreadDetailResult>;
    resolveThreadOwnership: (input: GetThreadOwnershipInput) => Promise<GetThreadOwnershipResult>;
    getCommandOutcome: (input: GetCommandOutcomeInput) => Promise<GetCommandOutcomeResult>;
    getSnapshot: () => Promise<OrchestrationReadModel>;
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    replayEvents: (fromSequenceExclusive: number) => Promise<OrchestrationReplayEventsResult>;
    acknowledgeDelivery: (
      input: OrchestrationApplicationAckInput,
    ) => Promise<OrchestrationApplicationAckResult>;
    acknowledgeDeliveryBaseline: (
      input: OrchestrationBaselineAckInput,
    ) => Promise<OrchestrationBaselineAckResult>;
    onDomainEvent: (
      callback: (event: OrchestrationDeliveryStreamItem) => void | Promise<void>,
      options?: { onResubscribe?: () => void },
    ) => () => void;
    onThinkingDelta: (
      callback: (event: ThinkingActivityDeltaEvent) => void,
      options?: { onResubscribe?: () => void },
    ) => () => void;
  };
}
import type {
  ServerOpencodeV2ThreadToolsSetupInput,
  ServerOpencodeV2ThreadToolsSetupResult,
} from "./server.opencodeV2ThreadToolsSetup";
