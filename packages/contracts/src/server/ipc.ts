import type {
  GitCheckoutInput,
  GitCheckoutResult,
  GitCreateBranchInput,
  GitCreateBranchResult,
  GitGetCommitDetailsInput,
  GitGetCommitDetailsResult,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitDiscardChangesInput,
  GitFetchInput,
  GitFetchResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitListCommitsInput,
  GitListCommitsResult,
  GitPullInput,
  GitPullResult,
  GitReadWorkingTreeDiffInput,
  GitReadWorkingTreeDiffResult,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitStatusInput,
  GitStatusResult,
  GitStatusStreamEvent,
} from "../workspace/git";
import type {
  ProjectDirectoryWatchEvent,
  ProjectDirectoryWatchInput,
  ProjectSearchFileContentsInput,
  ProjectSearchFileContentsResult,
  ProjectListDirectoryInput,
  ProjectListDirectoryResult,
  ProjectReadFilePreviewInput,
  ProjectReadFilePreviewResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "../workspace/project";
import type {
  KanbanCard,
  KanbanCreateInput,
  KanbanDeleteInput,
  KanbanDeleteResult,
  KanbanGetInput,
  KanbanListInput,
  KanbanListResult,
  KanbanMoveInput,
  KanbanReorderInput,
  KanbanUpdateInput,
} from "./kanban";
import type {
  Note,
  NotesCreateInput,
  NotesDeleteInput,
  NotesDeleteResult,
  NotesGetInput,
  NotesListInput,
  NotesListResult,
  NotesUpdateInput,
} from "./notes";
import type { TeachListProjectsInput, TeachListProjectsResult } from "./teach";
import type {
  ServerConfig,
  ServerReadDocumentUrlInput,
  ServerReadDocumentUrlResult,
  ServerProviderUpdatedPayload,
  ServerUnlockSshKeyInput,
  ServerUnlockSshKeyResult,
  ServerUnlockSshPasswordInput,
  ServerUnlockSshPasswordResult,
  ServerUpsertKeybindingResult,
  ServerVerifyExecutionTargetInput,
  ServerVerifyExecutionTargetResult,
  ServerWriteHandoffDocumentInput,
  ServerWriteHandoffDocumentResult,
  ServerExportThreadContextInput,
  ServerExportThreadContextResult,
} from "./server";
import type {
  ServerGetHandoffJobInput,
  ServerHandoffJob,
  ServerStartHandoffJobInput,
} from "./server.handoff";
import type {
  ServerCreateMobileRemotePairingInput,
  ServerListMobileRemoteSessionsResult,
  ServerMobileRemotePairing,
  ServerRevokeMobileRemoteSessionInput,
} from "./mobile";
import type {
  ServerAutomationResult,
  ServerCreateAutomationInput,
  ServerDeleteAutomationInput,
  ServerGetAutomationInput,
  ServerGetAutomationResult,
  ServerListAutomationRunsInput,
  ServerListAutomationRunsResult,
  ServerListAllAutomationsInput,
  ServerListAllAutomationsResult,
  ServerListAutomationsInput,
  ServerListAutomationsResult,
  ServerPauseAutomationInput,
  ServerResumeAutomationInput,
  ServerTriggerAutomationInput,
  ServerTriggerAutomationResult,
  ServerUpdateAutomationInput,
} from "./automation";
import type { ServerGetUsageSummaryInput, ServerUsageSummaryResult } from "./usage";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "../workspace/terminal";
import type { ServerUpsertKeybindingInput } from "./server";
import type {
  ClientOrchestrationCommand,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationEvent,
  OrchestrationReadModel,
  ThinkingActivityDeltaEvent,
} from "../orchestration/orchestration";
import { EditorId } from "../workspace/editor";
import { type DesktopWindowMaterial, ServerSettings, ServerSettingsPatch } from "../core/settings";
import type { DesktopComputerUseBridge } from "./ipc.desktopComputerUse";
export * from "./ipc.desktopComputerUse";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
}

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopRuntimePlatform = "darwin" | "linux" | "win32" | "other";
export type DesktopTheme = "light" | "dark" | "system";

export interface DesktopRuntimeInfo {
  platform: DesktopRuntimePlatform;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  isCodeSigned: boolean;
}

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  currentVersion: string;
  platform: DesktopRuntimePlatform;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  isCodeSigned: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
}

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export interface DesktopUpdateCheckResult {
  checked: boolean;
  state: DesktopUpdateState;
}

export interface DesktopNotificationInput {
  title: string;
  body?: string;
  silent?: boolean;
}

export interface DesktopTailscaleRemoteAccessStatus {
  installed: boolean;
  running: boolean;
  online: boolean;
  serving: boolean;
  remoteBaseUrl: string | null;
  error: string | null;
}

export interface DesktopBridge extends DesktopComputerUseBridge {
  getWsUrl: () => string | null;
  getMobileBackendBaseUrl: () => string | null;
  getTailscaleRemoteAccessStatus: () => Promise<DesktopTailscaleRemoteAccessStatus>;
  enableTailscaleRemoteAccess: () => Promise<DesktopTailscaleRemoteAccessStatus>;
  disableTailscaleRemoteAccess: () => Promise<DesktopTailscaleRemoteAccessStatus>;
  /** Returns the absolute filesystem path for a File object (Electron webUtils.getPathForFile). */
  getFilePath: (file: File) => string;
  pickFolder: () => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  setWindowMaterial: (windowMaterial: DesktopWindowMaterial) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  notifications: {
    isSupported: () => Promise<boolean>;
    show: (input: DesktopNotificationInput) => Promise<boolean>;
  };
  copyToClipboard: (text: string) => Promise<void>;
  requestFileAccess: (
    level: "unrestricted" | "common-folders",
  ) => Promise<{ success: boolean; granted: string[]; denied: string[] }>;
}

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
    open: (input: typeof TerminalOpenInput.Encoded) => Promise<TerminalSessionSnapshot>;
    write: (input: typeof TerminalWriteInput.Encoded) => Promise<void>;
    resize: (input: typeof TerminalResizeInput.Encoded) => Promise<void>;
    clear: (input: typeof TerminalClearInput.Encoded) => Promise<void>;
    restart: (input: typeof TerminalRestartInput.Encoded) => Promise<TerminalSessionSnapshot>;
    close: (input: typeof TerminalCloseInput.Encoded) => Promise<void>;
    onEvent: (callback: (event: TerminalEvent) => void) => () => void;
  };
  projects: {
    listDirectory: (input: ProjectListDirectoryInput) => Promise<ProjectListDirectoryResult>;
    onDirectoryChange: (
      input: ProjectDirectoryWatchInput,
      callback: (event: ProjectDirectoryWatchEvent) => void,
      options?: { onResubscribe?: () => void },
    ) => () => void;
    readFilePreview: (input: ProjectReadFilePreviewInput) => Promise<ProjectReadFilePreviewResult>;
    searchFileContents: (
      input: ProjectSearchFileContentsInput,
    ) => Promise<ProjectSearchFileContentsResult>;
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
  };
  notes: {
    list: (input: NotesListInput) => Promise<NotesListResult>;
    get: (input: NotesGetInput) => Promise<Note>;
    create: (input: NotesCreateInput) => Promise<Note>;
    update: (input: NotesUpdateInput) => Promise<Note>;
    delete: (input: NotesDeleteInput) => Promise<NotesDeleteResult>;
  };
  kanban: {
    list: (input: KanbanListInput) => Promise<KanbanListResult>;
    get: (input: KanbanGetInput) => Promise<KanbanCard>;
    create: (input: KanbanCreateInput) => Promise<KanbanCard>;
    update: (input: KanbanUpdateInput) => Promise<KanbanCard>;
    delete: (input: KanbanDeleteInput) => Promise<KanbanDeleteResult>;
    move: (input: KanbanMoveInput) => Promise<KanbanCard>;
    reorder: (input: KanbanReorderInput) => Promise<KanbanCard>;
  };
  teach: {
    listProjects: (input?: TeachListProjectsInput) => Promise<TeachListProjectsResult>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    openPath: (path: string) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
  git: {
    // Existing branch/worktree API
    listBranches: (input: GitListBranchesInput) => Promise<GitListBranchesResult>;
    listCommits: (input: GitListCommitsInput) => Promise<GitListCommitsResult>;
    getCommitDetails: (input: GitGetCommitDetailsInput) => Promise<GitGetCommitDetailsResult>;
    readWorkingTreeDiff: (
      input: GitReadWorkingTreeDiffInput,
    ) => Promise<GitReadWorkingTreeDiffResult>;
    createWorktree: (input: GitCreateWorktreeInput) => Promise<GitCreateWorktreeResult>;
    removeWorktree: (input: GitRemoveWorktreeInput) => Promise<void>;
    createBranch: (input: GitCreateBranchInput) => Promise<GitCreateBranchResult>;
    checkout: (input: GitCheckoutInput) => Promise<GitCheckoutResult>;
    init: (input: GitInitInput) => Promise<void>;
    resolvePullRequest: (input: GitPullRequestRefInput) => Promise<GitResolvePullRequestResult>;
    preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Promise<GitPreparePullRequestThreadResult>;
    // Stacked action API
    pull: (input: GitPullInput) => Promise<GitPullResult>;
    fetch: (input: GitFetchInput) => Promise<GitFetchResult>;
    discardChanges: (input: GitDiscardChangesInput) => Promise<void>;
    refreshStatus: (input: GitStatusInput) => Promise<GitStatusResult>;
    onStatus: (
      input: GitStatusInput,
      callback: (event: GitStatusStreamEvent) => void,
    ) => () => void;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  server: {
    getConfig: () => Promise<ServerConfig>;
    refreshProviders: () => Promise<ServerProviderUpdatedPayload>;
    verifyExecutionTarget: (
      input: ServerVerifyExecutionTargetInput,
    ) => Promise<ServerVerifyExecutionTargetResult>;
    unlockSshKey: (input: ServerUnlockSshKeyInput) => Promise<ServerUnlockSshKeyResult>;
    unlockSshPassword: (
      input: ServerUnlockSshPasswordInput,
    ) => Promise<ServerUnlockSshPasswordResult>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
    getSettings: () => Promise<ServerSettings>;
    updateSettings: (patch: ServerSettingsPatch) => Promise<ServerSettings>;
    readDocumentUrl: (input: ServerReadDocumentUrlInput) => Promise<ServerReadDocumentUrlResult>;
    writeHandoffDocument: (
      input: ServerWriteHandoffDocumentInput,
    ) => Promise<ServerWriteHandoffDocumentResult>;
    startHandoffJob: (input: ServerStartHandoffJobInput) => Promise<ServerHandoffJob>;
    getHandoffJob: (input: ServerGetHandoffJobInput) => Promise<ServerHandoffJob>;
    createMobileRemotePairing: (
      input: ServerCreateMobileRemotePairingInput,
    ) => Promise<ServerMobileRemotePairing>;
    listMobileRemoteSessions: () => Promise<ServerListMobileRemoteSessionsResult>;
    revokeMobileRemoteSession: (input: ServerRevokeMobileRemoteSessionInput) => Promise<void>;
    exportThreadContext: (
      input: ServerExportThreadContextInput,
    ) => Promise<ServerExportThreadContextResult>;
    getAutomation: (input: ServerGetAutomationInput) => Promise<ServerGetAutomationResult>;
    listAutomations: (input: ServerListAutomationsInput) => Promise<ServerListAutomationsResult>;
    listAllAutomations: (
      input?: ServerListAllAutomationsInput,
    ) => Promise<ServerListAllAutomationsResult>;
    createAutomation: (input: ServerCreateAutomationInput) => Promise<ServerAutomationResult>;
    updateAutomation: (input: ServerUpdateAutomationInput) => Promise<ServerAutomationResult>;
    pauseAutomation: (input: ServerPauseAutomationInput) => Promise<void>;
    resumeAutomation: (input: ServerResumeAutomationInput) => Promise<void>;
    deleteAutomation: (input: ServerDeleteAutomationInput) => Promise<void>;
    triggerAutomation: (
      input: ServerTriggerAutomationInput,
    ) => Promise<ServerTriggerAutomationResult>;
    listAutomationRuns: (
      input: ServerListAutomationRunsInput,
    ) => Promise<ServerListAutomationRunsResult>;
    getUsageSummary: (input: ServerGetUsageSummaryInput) => Promise<ServerUsageSummaryResult>;
  };
  orchestration: {
    getSnapshot: () => Promise<OrchestrationReadModel>;
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    replayEvents: (fromSequenceExclusive: number) => Promise<OrchestrationEvent[]>;
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
