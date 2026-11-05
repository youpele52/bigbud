import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { MessageId } from "@bigbud/contracts/core/baseSchemas";
import { ensureSessionForThread } from "../../../orchestration/Layers/ProviderCommandReactorSessionOps.ts";
import {
  withWorkspaceApp,
  threadId,
  createdAt,
  workspaceModel,
} from "./Application.workspace.fixture.ts";

const probe = vi.hoisted(() => vi.fn(async () => ({ os: "linux", architecture: "x86_64" })));
vi.mock("../../../remote-workspace-bridge/remoteWorkspaceReadiness.ts", () => ({
  probeRemoteWorkspaceReadiness: probe,
}));
afterEach(() => vi.restoreAllMocks());

it.each([true, false])(
  "reactor sends first, second and third turns through ProviderService (remote=%s)",
  async (remote) => {
    await withWorkspaceApp(remote, async (h) => {
      await h.send("first");
      const first = h.runtime.get(threadId);
      const cursor = first.session.resumeCursor;
      await h.send("second");
      await h.send("third");
      expect(first.session.cwd).toBe(h.cwd);
      expect(h.runtime.get(threadId)).toBe(first);
      expect(first.session.resumeCursor).toEqual(cursor);
      expect(h.prompts()).toHaveLength(3);
      expect(h.creations()).toHaveLength(1);
      expect(h.start).toHaveBeenCalledTimes(1);
      expect((await h.binding()).runtimePayload).toMatchObject({ cwd: h.cwd });
    });
  },
);

it.each(["target", "project", "worktree", "native-location"] as const)(
  "reactor rejects changed remote %s before dispatch/replacement",
  async (change) => {
    await withWorkspaceApp(true, async (h) => {
      await h.send("first");
      const owner = h.runtime.get(threadId);
      if (change === "target")
        h.updateThread({ workspaceExecutionTargetId: "ssh:other", executionTargetId: "ssh:other" });
      if (change === "project") h.project.workspaceRoot = "/srv/other-project";
      if (change === "worktree") h.updateThread({ worktreePath: "/srv/other-worktree" });
      if (change === "native-location")
        owner.session = {
          ...owner.session,
          resumeCursor: { ...(owner.session.resumeCursor as object), directory: h.cwd },
        };
      const calls = h.http.calls.length;
      await expect(h.send("blocked")).rejects.toThrow("active session Location");
      expect(h.http.calls).toHaveLength(calls);
      expect(h.runtime.get(threadId)).toBe(owner);
      expect(h.prompts()).toHaveLength(1);
      expect(h.creations()).toHaveLength(1);
      expect(h.start).toHaveBeenCalledTimes(1);
    });
  },
);

it("ProviderService recovers persisted remote cwd after adapter loss, and explicit stop/restart preserves native history", async () => {
  await withWorkspaceApp(true, async (h) => {
    await h.send("first");
    const native = h.runtime.get(threadId).native;
    const saved = await h.binding();
    // Lose only the in-memory owner, preserving the ProviderService directory and native history.
    await Effect.runPromise(h.adapter.stopSession(threadId));
    await Effect.runPromise(
      h.provider.sendTurn({
        threadId,
        requestMessageId: MessageId.makeUnsafe("recovered"),
        input: "recovered",
        modelSelection: workspaceModel,
      }),
    );
    await expect.poll(() => h.runtime.get(threadId).terminalDelivered).toBe(true);
    expect(h.runtime.get(threadId).native.id).toBe(native.id);
    expect(h.runtime.get(threadId).native.location).toEqual(native.location);
    expect(h.start.mock.calls.at(-1)?.[0].cwd).toBe(h.cwd);
    expect(h.start.mock.calls.at(-1)?.[0].resumeCursor).toEqual(saved.resumeCursor);
    await Effect.runPromise(h.provider.stopSession({ threadId }));
    await Effect.runPromise(ensureSessionForThread(h.services)(threadId, createdAt));
    await h.send("after-explicit-restart");
    expect(h.runtime.get(threadId).native.id).toBe(native.id);
    expect(h.prompts()).toHaveLength(3);
    expect(h.creations()).toHaveLength(1);
  });
});

it("broken persisted synthetic cwd fails closed before remote preparation; canonical reconnect resumes the original history", async () => {
  await withWorkspaceApp(true, async (h) => {
    await h.send("first");
    const native = h.runtime.get(threadId).native;
    const binding = await h.binding();
    await Effect.runPromise(h.adapter.stopSession(threadId));
    await Effect.runPromise(
      h.directory.upsert({
        ...binding,
        runtimePayload: { ...(binding.runtimePayload as object), cwd: native.location.directory },
      }),
    );
    const calls = h.http.calls.length;
    const probes = probe.mock.calls.length;
    await expect(
      Effect.runPromise(
        h.provider.sendTurn({
          threadId,
          requestMessageId: MessageId.makeUnsafe("legacy"),
          input: "legacy",
          modelSelection: workspaceModel,
        }),
      ),
    ).rejects.toThrow("Reconnect this thread from its original workspace");
    expect(h.http.calls).toHaveLength(calls);
    expect(probe.mock.calls).toHaveLength(probes);
    expect(h.prompts()).toHaveLength(1);
    expect((await h.binding()).resumeCursor).toEqual(binding.resumeCursor);
    await Effect.runPromise(ensureSessionForThread(h.services)(threadId, createdAt));
    await h.send("canonical-reconnect");
    expect(h.runtime.get(threadId).native.id).toBe(native.id);
    expect(h.runtime.get(threadId).native.location).toEqual(native.location);
    expect((await h.binding()).runtimePayload).toMatchObject({ cwd: h.cwd });
    expect(h.creations()).toHaveLength(1);
  });
});
