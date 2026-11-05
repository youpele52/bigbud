import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { ensureSessionForThread } from "../../../orchestration/Layers/ProviderCommandReactorSessionOps.ts";
import { withWorkspaceApp, threadId, createdAt } from "./Application.workspace.fixture.ts";

vi.mock("../../../remote-workspace-bridge/remoteWorkspaceReadiness.ts", () => ({
  probeRemoteWorkspaceReadiness: async () => ({ os: "linux", architecture: "x86_64" }),
}));
afterEach(() => vi.restoreAllMocks());

it.each(["target", "project", "worktree"] as const)(
  "explicit remote reconnect rejects changed %s and retains original native history",
  async (change) => {
    await withWorkspaceApp(true, async (h) => {
      await h.send("first");
      const native = h.runtime.get(threadId).native;
      const saved = await h.binding();
      await Effect.runPromise(h.provider.stopSession({ threadId }));
      if (change === "target")
        h.updateThread({ workspaceExecutionTargetId: "ssh:other", executionTargetId: "ssh:other" });
      if (change === "project") h.project.workspaceRoot = "/srv/other-project";
      if (change === "worktree") h.updateThread({ worktreePath: "/srv/other-worktree" });
      const calls = h.http.calls.length;
      await expect(
        Effect.runPromise(ensureSessionForThread(h.services)(threadId, createdAt)),
      ).rejects.toThrow("retained shared history conflicts");
      expect(h.http.calls).toHaveLength(calls);
      expect(h.creations()).toHaveLength(1);
      expect(h.prompts()).toHaveLength(1);
      expect((await h.binding()).resumeCursor).toEqual(saved.resumeCursor);
      h.project.workspaceRoot = h.cwd;
      h.updateThread({
        workspaceExecutionTargetId: h.target,
        executionTargetId: h.target,
        worktreePath: null,
      });
      await Effect.runPromise(ensureSessionForThread(h.services)(threadId, createdAt));
      expect(h.runtime.get(threadId).native.id).toBe(native.id);
      expect(h.runtime.get(threadId).native.location).toEqual(native.location);
      expect(h.creations()).toHaveLength(1);
    });
  },
);

it.each(["C:\\project", "relative/project"])(
  "remote preparation rejects unsupported/non-absolute path %s rather than applying local normalization",
  async (cwd) => {
    await withWorkspaceApp(true, async (h) => {
      h.project.workspaceRoot = cwd;
      await expect(
        Effect.runPromise(ensureSessionForThread(h.services)(threadId, createdAt)),
      ).rejects.toThrow("absolute POSIX project root");
      expect(h.http.calls).toHaveLength(0);
      expect(h.creations()).toHaveLength(0);
    });
  },
);
