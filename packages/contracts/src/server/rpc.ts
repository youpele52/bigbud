import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { OpenError, OpenInEditorInput, OpenPathInput } from "../workspace/editor";
import {
  GitActionProgressEvent,
  GitCheckoutInput,
  GitCheckoutResult,
  GitCommandError,
  GitExecutionTargetError,
  GitCreateBranchInput,
  GitCreateBranchResult,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitDiscardChangesInput,
  GitFetchInput,
  GitFetchResult,
  GitGetCommitDetailsInput,
  GitGetCommitDetailsResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitListCommitsInput,
  GitListCommitsResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullInput,
  GitPullRequestRefInput,
  GitPullResult,
  GitReadWorkingTreeDiffInput,
  GitReadWorkingTreeDiffResult,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitServiceError,
  GitStatusInput,
  GitStatusResult,
  GitStatusStreamEvent,
} from "../workspace/git";
import { KeybindingsConfigError } from "./keybindings";
import {
  ClientOrchestrationCommand,
  OrchestrationEvent,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationGetSnapshotInput,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsError,
  OrchestrationReplayEventsInput,
  OrchestrationRpcSchemas,
  ThinkingActivityDeltaEvent,
} from "../orchestration/orchestration";
import {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "../workspace/terminal";
import {
  ServerConfigStreamEvent,
  ServerConfig,
  ServerReadDocumentUrlError,
  ServerReadDocumentUrlInput,
  ServerReadDocumentUrlResult,
  ServerWriteHandoffDocumentError,
  ServerWriteHandoffDocumentInput,
  ServerWriteHandoffDocumentResult,
  ServerExportThreadContextError,
  ServerExportThreadContextInput,
  ServerExportThreadContextResult,
  ServerLifecycleStreamEvent,
  ServerProviderUpdatedPayload,
  ServerUnlockSshKeyError,
  ServerUnlockSshKeyInput,
  ServerUnlockSshKeyResult,
  ServerUnlockSshPasswordError,
  ServerUnlockSshPasswordInput,
  ServerUnlockSshPasswordResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
  ServerVerifyExecutionTargetError,
  ServerVerifyExecutionTargetInput,
  ServerVerifyExecutionTargetResult,
} from "./server";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "../core/settings";
import { WS_METHODS } from "../constants/websocket.constant";
import {
  WsKanbanCreateRpc,
  WsKanbanDeleteRpc,
  WsKanbanGetRpc,
  WsKanbanListRpc,
  WsKanbanMoveRpc,
  WsKanbanUpdateRpc,
  WsNotesCreateRpc,
  WsNotesDeleteRpc,
  WsNotesGetRpc,
  WsNotesListRpc,
  WsNotesUpdateRpc,
  WsTeachListProjectsRpc,
  WsProjectsListDirectoryRpc,
  WsProjectsReadFilePreviewRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsSearchFileContentsRpc,
  WsProjectsWriteFileRpc,
  WsSubscribeProjectDirectoryChangesRpc,
} from "./rpc.workspace";
import {
  WsServerCreateAutomationRpc,
  WsServerDeleteAutomationRpc,
  WsServerGetAutomationRpc,
  WsServerListAutomationRunsRpc,
  WsServerListAllAutomationsRpc,
  WsServerListAutomationsRpc,
  WsServerPauseAutomationRpc,
  WsServerResumeAutomationRpc,
  WsServerTriggerAutomationRpc,
  WsServerUpdateAutomationRpc,
} from "./rpc.automation";

export { WS_METHODS };

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: KeybindingsConfigError,
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({}),
  success: ServerProviderUpdatedPayload,
});

export const WsServerVerifyExecutionTargetRpc = Rpc.make(WS_METHODS.serverVerifyExecutionTarget, {
  payload: ServerVerifyExecutionTargetInput,
  success: ServerVerifyExecutionTargetResult,
  error: ServerVerifyExecutionTargetError,
});

export const WsServerUnlockSshKeyRpc = Rpc.make(WS_METHODS.serverUnlockSshKey, {
  payload: ServerUnlockSshKeyInput,
  success: ServerUnlockSshKeyResult,
  error: ServerUnlockSshKeyError,
});

export const WsServerUnlockSshPasswordRpc = Rpc.make(WS_METHODS.serverUnlockSshPassword, {
  payload: ServerUnlockSshPasswordInput,
  success: ServerUnlockSshPasswordResult,
  error: ServerUnlockSshPasswordError,
});

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: ServerSettingsError,
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: ServerSettingsError,
});

export const WsServerReadDocumentUrlRpc = Rpc.make(WS_METHODS.serverReadDocumentUrl, {
  payload: ServerReadDocumentUrlInput,
  success: ServerReadDocumentUrlResult,
  error: ServerReadDocumentUrlError,
});

export const WsServerWriteHandoffDocumentRpc = Rpc.make(WS_METHODS.serverWriteHandoffDocument, {
  payload: ServerWriteHandoffDocumentInput,
  success: ServerWriteHandoffDocumentResult,
  error: ServerWriteHandoffDocumentError,
});

export const WsServerExportThreadContextRpc = Rpc.make(WS_METHODS.serverExportThreadContext, {
  payload: ServerExportThreadContextInput,
  success: ServerExportThreadContextResult,
  error: ServerExportThreadContextError,
});

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: OpenInEditorInput,
  error: OpenError,
});

export const WsShellOpenPathRpc = Rpc.make(WS_METHODS.shellOpenPath, {
  payload: OpenPathInput,
  error: OpenError,
});

export const WsSubscribeGitStatusRpc = Rpc.make(WS_METHODS.subscribeGitStatus, {
  payload: GitStatusInput,
  success: GitStatusStreamEvent,
  error: GitManagerServiceError,
  stream: true,
});

export const WsGitPullRpc = Rpc.make(WS_METHODS.gitPull, {
  payload: GitPullInput,
  success: GitPullResult,
  error: Schema.Union([GitCommandError, GitExecutionTargetError]),
});

export const WsGitRefreshStatusRpc = Rpc.make(WS_METHODS.gitRefreshStatus, {
  payload: GitStatusInput,
  success: GitStatusResult,
  error: GitManagerServiceError,
});

export const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: GitManagerServiceError,
  stream: true,
});

export const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: GitManagerServiceError,
});

export const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: GitManagerServiceError,
});

export const WsGitListBranchesRpc = Rpc.make(WS_METHODS.gitListBranches, {
  payload: GitListBranchesInput,
  success: GitListBranchesResult,
  error: GitServiceError,
});

export const WsGitListCommitsRpc = Rpc.make(WS_METHODS.gitListCommits, {
  payload: GitListCommitsInput,
  success: GitListCommitsResult,
  error: Schema.Union([GitCommandError, GitExecutionTargetError]),
});

export const WsGitGetCommitDetailsRpc = Rpc.make(WS_METHODS.gitGetCommitDetails, {
  payload: GitGetCommitDetailsInput,
  success: GitGetCommitDetailsResult,
  error: Schema.Union([GitCommandError, GitExecutionTargetError]),
});

export const WsGitReadWorkingTreeDiffRpc = Rpc.make(WS_METHODS.gitReadWorkingTreeDiff, {
  payload: GitReadWorkingTreeDiffInput,
  success: GitReadWorkingTreeDiffResult,
  error: Schema.Union([GitCommandError, GitExecutionTargetError]),
});

export const WsGitCreateWorktreeRpc = Rpc.make(WS_METHODS.gitCreateWorktree, {
  payload: GitCreateWorktreeInput,
  success: GitCreateWorktreeResult,
  error: GitServiceError,
});

export const WsGitRemoveWorktreeRpc = Rpc.make(WS_METHODS.gitRemoveWorktree, {
  payload: GitRemoveWorktreeInput,
  error: GitServiceError,
});

export const WsGitCreateBranchRpc = Rpc.make(WS_METHODS.gitCreateBranch, {
  payload: GitCreateBranchInput,
  success: GitCreateBranchResult,
  error: GitServiceError,
});

export const WsGitCheckoutRpc = Rpc.make(WS_METHODS.gitCheckout, {
  payload: GitCheckoutInput,
  success: GitCheckoutResult,
  error: GitServiceError,
});

export const WsGitInitRpc = Rpc.make(WS_METHODS.gitInit, {
  payload: GitInitInput,
  error: GitServiceError,
});

export const WsGitFetchRpc = Rpc.make(WS_METHODS.gitFetch, {
  payload: GitFetchInput,
  success: GitFetchResult,
  error: GitServiceError,
});

export const WsGitDiscardChangesRpc = Rpc.make(WS_METHODS.gitDiscardChanges, {
  payload: GitDiscardChangesInput,
  error: GitServiceError,
});

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: TerminalError,
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: TerminalError,
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: TerminalError,
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: TerminalError,
});

export const WsOrchestrationGetSnapshotRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getSnapshot, {
  payload: OrchestrationGetSnapshotInput,
  success: OrchestrationRpcSchemas.getSnapshot.output,
  error: OrchestrationGetSnapshotError,
});

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: OrchestrationDispatchCommandError,
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: OrchestrationGetTurnDiffError,
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: OrchestrationGetFullThreadDiffError,
  },
);

export const WsOrchestrationReplayEventsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.replayEvents, {
  payload: OrchestrationReplayEventsInput,
  success: OrchestrationRpcSchemas.replayEvents.output,
  error: OrchestrationReplayEventsError,
});

export const WsSubscribeOrchestrationDomainEventsRpc = Rpc.make(
  WS_METHODS.subscribeOrchestrationDomainEvents,
  {
    payload: Schema.Struct({}),
    success: OrchestrationEvent,
    stream: true,
  },
);

export const WsSubscribeThinkingActivityDeltasRpc = Rpc.make(
  WS_METHODS.subscribeThinkingActivityDeltas,
  {
    payload: Schema.Struct({}),
    success: ThinkingActivityDeltaEvent,
    stream: true,
  },
);

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
  stream: true,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  stream: true,
});

export const WsRpcGroup = RpcGroup.make(
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerVerifyExecutionTargetRpc,
  WsServerUnlockSshKeyRpc,
  WsServerUnlockSshPasswordRpc,
  WsServerUpsertKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerReadDocumentUrlRpc,
  WsServerWriteHandoffDocumentRpc,
  WsServerExportThreadContextRpc,
  WsServerGetAutomationRpc,
  WsServerListAllAutomationsRpc,
  WsServerListAutomationsRpc,
  WsServerCreateAutomationRpc,
  WsServerUpdateAutomationRpc,
  WsServerPauseAutomationRpc,
  WsServerResumeAutomationRpc,
  WsServerDeleteAutomationRpc,
  WsServerTriggerAutomationRpc,
  WsServerListAutomationRunsRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsSearchFileContentsRpc,
  WsProjectsListDirectoryRpc,
  WsSubscribeProjectDirectoryChangesRpc,
  WsProjectsReadFilePreviewRpc,
  WsProjectsWriteFileRpc,
  WsKanbanListRpc,
  WsKanbanGetRpc,
  WsKanbanCreateRpc,
  WsKanbanUpdateRpc,
  WsKanbanDeleteRpc,
  WsKanbanMoveRpc,
  WsNotesListRpc,
  WsNotesGetRpc,
  WsNotesCreateRpc,
  WsNotesUpdateRpc,
  WsNotesDeleteRpc,
  WsTeachListProjectsRpc,
  WsShellOpenInEditorRpc,
  WsShellOpenPathRpc,
  WsSubscribeGitStatusRpc,
  WsGitPullRpc,
  WsGitRefreshStatusRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsGitListBranchesRpc,
  WsGitListCommitsRpc,
  WsGitGetCommitDetailsRpc,
  WsGitReadWorkingTreeDiffRpc,
  WsGitCreateWorktreeRpc,
  WsGitRemoveWorktreeRpc,
  WsGitCreateBranchRpc,
  WsGitCheckoutRpc,
  WsGitInitRpc,
  WsGitFetchRpc,
  WsGitDiscardChangesRpc,
  WsTerminalOpenRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeOrchestrationDomainEventsRpc,
  WsSubscribeThinkingActivityDeltasRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsOrchestrationGetSnapshotRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationReplayEventsRpc,
);
