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
  Note,
  NotesCreateInput,
  NotesDeleteInput,
  NotesDeleteResult,
  NotesGetInput,
  NotesListInput,
  NotesListResult,
  NotesUpdateInput,
} from "./notes";
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
} from "./server";
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
import { ServerSettings, ServerSettingsPatch } from "../core/settings";

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

export interface DesktopBridge {
  getWsUrl: () => string | null;
  /** Returns the absolute filesystem path for a File object (Electron webUtils.getPathForFile). */
  getFilePath: (file: File) => string;
  pickFolder: () => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
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
