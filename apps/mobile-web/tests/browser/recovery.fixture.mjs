const now = "2026-09-09T00:00:00.000Z";
export const thread = {
  id: "thread-recovery",
  projectId: "project-recovery",
  title: "Recovery route fixture",
  modelSelection: { provider: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  messages: [
    {
      id: "message-cached",
      role: "assistant",
      text: "Cached conversation survives suspension",
      turnId: null,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  ],
  activities: [],
  checkpoints: [],
  session: null,
};
export const snapshot = {
  snapshotSequence: 0,
  updatedAt: now,
  projects: [
    {
      id: thread.projectId,
      title: "Recovery project",
      workspaceRoot: null,
      defaultModelSelection: thread.modelSelection,
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [{ ...thread, messages: [] }],
};
export const session = {
  sessionId: "browser-recovery",
  sessionToken: "fixture-only",
  backendBaseUrl: "http://127.0.0.1:15743",
  websocketUrl: "ws://127.0.0.1:15743/mobile-ws",
  scope: "thread-control",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
