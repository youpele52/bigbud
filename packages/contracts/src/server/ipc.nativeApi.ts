import type { ServerSettings, ServerSettingsPatch } from "../core/settings";
import type {
  ClientOrchestrationCommand,
  GetProjectThreadSummariesInput,
  GetProjectThreadSummariesResult,
  GetSelectedThreadDetailInput,
  GetSelectedThreadDetailResult,
  GetSidebarThreadCatalogResult,
  GetStartupProjectCatalogInput,
  GetStartupProjectCatalogResult,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationReplayEventsResult,
  ThinkingActivityDeltaEvent,
} from "../orchestration/orchestration";
import type { EditorId } from "../workspace/editor";
import type { TerminalApplicationId } from "../workspace/terminalApplication";
import type * as Git from "../workspace/git";
import type * as Project from "../workspace/project";
import type * as Terminal from "../workspace/terminal";
import type * as Automation from "./automation";
import type { ContextMenuItem } from "./ipc";
import type * as Kanban from "./kanban";
import type * as Mobile from "./mobile";
import type * as Notes from "./notes";
import type * as PinnedThreads from "./pinnedThreads";
import type * as Server from "./server";
import type * as Handoff from "./server.handoff";
import type * as Retention from "./threadRetention";
import type * as Teach from "./teach";
import type * as Usage from "./usage";

export interface NativeApi {
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
    onEvent: (callback: (event: Terminal.TerminalEvent) => void) => () => void;
  };
  projects: {
    listDirectory: (
      input: Project.ProjectListDirectoryInput,
    ) => Promise<Project.ProjectListDirectoryResult>;
    onDirectoryChange: (
      input: Project.ProjectDirectoryWatchInput,
      callback: (event: Project.ProjectDirectoryWatchEvent) => void,
      options?: {
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
    activateCliProxy: () => Promise<Server.ServerProviderUpdatedPayload>;
    verifyExecutionTarget: (
      input: Server.ServerVerifyExecutionTargetInput,
    ) => Promise<Server.ServerVerifyExecutionTargetResult>;
    installRemoteAgent: (
      input: Server.ServerInstallRemoteAgentInput,
    ) => Promise<Server.ServerInstallRemoteAgentResult>;
    unlockSshKey: (
      input: Server.ServerUnlockSshKeyInput,
    ) => Promise<Server.ServerUnlockSshKeyResult>;
    unlockSshPassword: (
      input: Server.ServerUnlockSshPasswordInput,
    ) => Promise<Server.ServerUnlockSshPasswordResult>;
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
    ) => Promise<Retention.ServerThreadRetentionResult>;
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
    startHandoffJob: (
      input: Handoff.ServerStartHandoffJobInput,
    ) => Promise<Handoff.ServerHandoffJob>;
    getHandoffJob: (input: Handoff.ServerGetHandoffJobInput) => Promise<Handoff.ServerHandoffJob>;
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
  };
  orchestration: {
    getSidebarThreadCatalog: () => Promise<GetSidebarThreadCatalogResult>;
    getStartupProjectCatalog: (
      input: GetStartupProjectCatalogInput,
    ) => Promise<GetStartupProjectCatalogResult>;
    getProjectThreadSummaries: (
      input: GetProjectThreadSummariesInput,
    ) => Promise<GetProjectThreadSummariesResult>;
    getSelectedThreadDetail: (
      input: GetSelectedThreadDetailInput,
    ) => Promise<GetSelectedThreadDetailResult>;
    getSnapshot: () => Promise<OrchestrationReadModel>;
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    replayEvents: (fromSequenceExclusive: number) => Promise<OrchestrationReplayEventsResult>;
    onDomainEvent: (
      callback: (event: OrchestrationEvent) => void,
      options?: { onResubscribe?: () => void },
    ) => () => void;
    onThinkingDelta: (
      callback: (event: ThinkingActivityDeltaEvent) => void,
      options?: { onResubscribe?: () => void },
    ) => () => void;
  };
}
