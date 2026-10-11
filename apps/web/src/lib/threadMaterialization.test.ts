import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureThreadMaterialized } from "./threadMaterialization";
import { admitThreadCreationForSend } from "./threadMaterialization.admission";

const fixture = vi.hoisted(() => ({
  threads: [] as Array<{ id: string }>,
  projects: [] as Array<Record<string, unknown>>,
  draft: null as null | Record<string, unknown>,
  settings: {} as Record<string, unknown>,
  ownership: vi.fn(),
  dispatch: vi.fn(),
  detail: vi.fn(),
  outcome: vi.fn(),
  sync: vi.fn(),
  promote: vi.fn(),
  preserveEnvMode: vi.fn(),
}));
vi.mock("../rpc/nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      resolveThreadOwnership: fixture.ownership,
      dispatchCommand: fixture.dispatch,
      getSelectedThreadDetail: fixture.detail,
      getCommandOutcome: fixture.outcome,
    },
  }),
}));
vi.mock("../rpc/serverState", () => ({ getServerConfig: () => null }));
vi.mock("../stores/main", () => ({
  useStore: {
    getState: () => ({
      threads: fixture.threads,
      projects: fixture.projects,
      syncSelectedThreadDetail: fixture.sync,
    }),
  },
}));
vi.mock("../stores/composer", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getDraftThread: () => fixture.draft,
      draftsByThreadId: { "terminal-draft": fixture.settings },
    }),
  },
  clearPromotedDraftThread: fixture.promote,
}));
vi.mock("../stores/materialization/materializationLedger", () => ({
  readMaterializationLedger: () => ({ status: "ready", value: { attemptsByThreadId: {} } }),
}));
vi.mock("./threadMaterialization.envMode", () => ({
  preservePendingEnvMode: fixture.preserveEnvMode,
}));
vi.mock("../routes/-__root.bounded-bootstrap", () => ({
  runBoundedBootstrap: async () => {
    await fixture.detail();
    fixture.sync();
  },
}));
vi.mock("./orchestrationCommandRecovery.dispatch", () => ({
  dispatchCommandWithOutcomeRecovery: (
    api: { orchestration: { dispatchCommand: (command: unknown) => unknown } },
    command: unknown,
  ) => api.orchestration.dispatchCommand(command),
}));

const threadId = ThreadId.makeUnsafe("terminal-draft");
const projectId = ProjectId.makeUnsafe("creation-project");
beforeEach(() => {
  vi.clearAllMocks();
  fixture.threads = [];
  fixture.projects = [
    {
      id: projectId,
      cwd: "/origin",
      defaultModelSelection: { provider: "codex", model: "gpt-5.4" },
      workspaceExecutionTargetId: "ssh:origin",
    },
  ];
  fixture.draft = {
    projectId,
    createdAt: "2026-10-11T00:00:00.000Z",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: "/origin/worktree",
    envMode: "worktree",
  };
  fixture.settings = {
    prompt: "unsent prompt",
    activeProvider: "codex",
    modelSelectionByProvider: { codex: { provider: "codex", model: "gpt-5.4" } },
  };
  fixture.ownership.mockResolvedValue({ status: "absent" });
  fixture.dispatch.mockResolvedValue({ sequence: 1 });
  fixture.detail.mockResolvedValue({ threadId });
  fixture.outcome.mockResolvedValue({ status: "unknown" });
  fixture.sync.mockImplementation(() => {
    fixture.threads = [{ id: threadId }];
  });
  fixture.promote.mockImplementation(() => {
    fixture.draft = null;
  });
});

describe("normal durable terminal chat ownership", () => {
  it("shares one saved zero-message chat across bottom, right panel and simultaneous first send", async () => {
    const bottom = ensureThreadMaterialized(threadId);
    const right = ensureThreadMaterialized(threadId);
    const sending = admitThreadCreationForSend(threadId, true);
    await Promise.all([bottom, right]);
    expect((await sending).requiresCreate).toBe(false);
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    expect(fixture.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.create",
        threadId,
        projectId,
        title: "New thread",
        worktreePath: "/origin/worktree",
        workspaceExecutionTargetId: "ssh:origin",
      }),
    );
    expect(fixture.dispatch.mock.calls[0]?.[0]).not.toHaveProperty("seedMessages");
    expect(fixture.promote).toHaveBeenCalledWith(threadId);
    expect(fixture.settings.prompt).toBe("unsent prompt");
    expect(fixture.preserveEnvMode).toHaveBeenCalledWith(threadId, "worktree");
    await ensureThreadMaterialized(threadId);
    expect(fixture.dispatch).toHaveBeenCalledOnce();
  });

  it("waits for an in-flight first-send bootstrap instead of dispatching a second create", async () => {
    const sending = await admitThreadCreationForSend(ThreadId.makeUnsafe("send-first-draft"), true);
    const bottom = ensureThreadMaterialized(ThreadId.makeUnsafe("send-first-draft"));
    const right = ensureThreadMaterialized(ThreadId.makeUnsafe("send-first-draft"));
    expect(fixture.dispatch).not.toHaveBeenCalled();
    sending.settle(true);
    await Promise.all([bottom, right]);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("saves a global draft without replacing its creation project with the selected project", async () => {
    fixture.projects.push({ id: "later-selection", cwd: "/wrong" });
    fixture.draft = { ...fixture.draft, worktreePath: null, branch: null, envMode: "local" };
    await ensureThreadMaterialized(threadId);
    expect(fixture.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ projectId, worktreePath: null, branch: null }),
    );
  });

  it("does not start a terminal or promote the draft after saving fails, and permits an explicit retry", async () => {
    fixture.dispatch.mockRejectedValueOnce(new Error("offline"));
    await expect(ensureThreadMaterialized(threadId)).rejects.toThrow("offline");
    expect(fixture.promote).not.toHaveBeenCalled();
    await ensureThreadMaterialized(threadId);
    expect(fixture.dispatch).toHaveBeenCalledTimes(2);
    expect(fixture.dispatch.mock.calls[0]?.[0].commandId).toBe(
      fixture.dispatch.mock.calls[1]?.[0].commandId,
    );
  });

  it("recovers a saved owner after interrupted synchronization without issuing another create", async () => {
    fixture.detail.mockRejectedValueOnce(new Error("disconnected"));
    await expect(ensureThreadMaterialized(threadId)).rejects.toThrow("disconnected");
    fixture.ownership.mockResolvedValue({ status: "active" });
    fixture.outcome.mockResolvedValue({
      status: "accepted",
      aggregateKind: "thread",
      aggregateId: threadId,
    });
    await ensureThreadMaterialized(threadId);
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    expect(fixture.promote).toHaveBeenCalledOnce();
  });

  it("rejects archived or colliding owners instead of creating synthetic lease owners", async () => {
    fixture.ownership.mockResolvedValue({ status: "archived" });
    await expect(ensureThreadMaterialized(threadId)).rejects.toThrow("removed");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("uses a fresh stable command only after a previous save was definitively rejected", async () => {
    fixture.outcome.mockResolvedValueOnce({
      status: "rejected",
      aggregateKind: "thread",
      aggregateId: threadId,
      resultSequence: 4,
    });
    await ensureThreadMaterialized(threadId);
    expect(fixture.dispatch.mock.calls[0]?.[0].commandId).toBe(`thread-owner:${threadId}:after:4`);
  });
});
