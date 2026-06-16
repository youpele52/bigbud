/**
 * WebSocket RPC method names for the bigbud server.
 *
 * These method names are used for client-server communication over WebSocket.
 * Each method corresponds to a specific RPC endpoint.
 *
 * @see packages/contracts/src/rpc.ts for RPC schema definitions
 * @see APP_SERVER_NAME
 */
export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsSearchEntries: "projects.searchEntries",
  projectsSearchFileContents: "projects.searchFileContents",
  projectsListDirectory: "projects.listDirectory",
  subscribeProjectDirectoryChanges: "subscribeProjectDirectoryChanges",
  projectsReadFilePreview: "projects.readFilePreview",
  projectsWriteFile: "projects.writeFile",

  // Notes methods
  notesList: "notes.list",
  notesGet: "notes.get",
  notesCreate: "notes.create",
  notesUpdate: "notes.update",
  notesDelete: "notes.delete",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",
  shellOpenPath: "shell.openPath",

  // Git methods
  gitPull: "git.pull",
  gitRefreshStatus: "git.refreshStatus",
  gitRunStackedAction: "git.runStackedAction",
  gitListBranches: "git.listBranches",
  gitListCommits: "git.listCommits",
  gitGetCommitDetails: "git.getCommitDetails",
  gitReadWorkingTreeDiff: "git.readWorkingTreeDiff",
  gitCreateWorktree: "git.createWorktree",
  gitRemoveWorktree: "git.removeWorktree",
  gitCreateBranch: "git.createBranch",
  gitCheckout: "git.checkout",
  gitInit: "git.init",
  gitFetch: "git.fetch",
  gitDiscardChanges: "git.discardChanges",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverVerifyExecutionTarget: "server.verifyExecutionTarget",
  serverUnlockSshKey: "server.unlockSshKey",
  serverUnlockSshPassword: "server.unlockSshPassword",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverReadDocumentUrl: "server.readDocumentUrl",
  serverWriteHandoffDocument: "server.writeHandoffDocument",
  serverListAutomations: "server.listAutomations",
  serverCreateAutomation: "server.createAutomation",
  serverUpdateAutomation: "server.updateAutomation",
  serverPauseAutomation: "server.pauseAutomation",
  serverResumeAutomation: "server.resumeAutomation",
  serverDeleteAutomation: "server.deleteAutomation",
  serverTriggerAutomation: "server.triggerAutomation",
  serverListAutomationRuns: "server.listAutomationRuns",

  // Streaming subscriptions
  subscribeGitStatus: "subscribeGitStatus",
  subscribeOrchestrationDomainEvents: "subscribeOrchestrationDomainEvents",
  subscribeThinkingActivityDeltas: "subscribeThinkingActivityDeltas",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
} as const;

/**
 * Orchestration-specific WebSocket method names.
 *
 * These methods handle orchestration commands and queries for thread management,
 * turn execution, and event replay.
 */
export const ORCHESTRATION_WS_METHODS = {
  getSnapshot: "orchestration.getSnapshot",
  dispatchCommand: "orchestration.dispatchCommand",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  replayEvents: "orchestration.replayEvents",
} as const;
