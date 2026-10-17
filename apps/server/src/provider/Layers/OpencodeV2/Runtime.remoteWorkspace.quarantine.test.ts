import { expect, it, vi } from "vitest";
import type { SessionInfo } from "@opencode/client";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import type { WorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { prepareV2RemoteWorkspace } from "./Runtime.remoteWorkspace.ts";

const bridge = vi.hoisted(() => vi.fn());
vi.mock("../../../remote-workspace-bridge/remoteWorkspaceMcpBridge.ts", () => ({
  createRemoteWorkspaceMcpBridge: bridge,
}));
const modelSelection = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;

for (const mutation of ["add", "update", "verification"] as const)
  it(`remote ${mutation} ignoring abort cannot leak bridge invocation or admit conflicting work`, async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      const threadId = ThreadId.makeUnsafe(`remote-${mutation}`);
      await runtime.start({
        threadId,
        modelSelection,
        cwd: directory,
        runtimeMode: "approval-required",
      });
      const session = runtime.get(threadId);
      session.session = { ...session.session, workspaceExecutionTargetId: "ssh:synthetic" };
      let bridgeAlive = true;
      const cleanup = vi.fn(async () => {
        bridgeAlive = false;
      });
      bridge.mockResolvedValue({
        cwd: session.native.location.directory,
        serverPath: "disposable-server.mjs",
        cleanup,
      });
      let permissions: NonNullable<SessionInfo["permissions"]> = [
        { action: "*", resource: "*", effect: "deny" },
      ];
      const names = new Set<string>();
      const get = vi
        .spyOn(http.client.session, "get")
        .mockImplementation(async () => ({ ...session.native, permissions }));
      vi.spyOn(http.client.mcp, "list").mockImplementation(async () => ({
        location: session.native.location,
        data: [...names].map((name) => ({ name, status: { status: "connected" as const } })),
      }));
      const add = vi.spyOn(http.client.mcp, "add").mockImplementation(async (input) => {
        names.add(input.server);
      });
      const update = vi.spyOn(http.client.session, "update").mockImplementation(async (input) => {
        permissions = [...input.permissions!];
      });
      const remove = vi.spyOn(http.client.mcp, "remove").mockImplementation(async (input) => {
        names.delete(input.server);
      });
      let settle!: () => void;
      if (mutation === "add")
        add.mockImplementationOnce(
          (input) =>
            new Promise<void>((resolve) => {
              settle = () => {
                names.add(input.server);
                resolve();
              };
            }),
        );
      else if (mutation === "update")
        update.mockImplementationOnce(
          (input) =>
            new Promise<void>((resolve) => {
              settle = () => {
                permissions = [...input.permissions!];
                resolve();
              };
            }),
        );
      else
        get.mockImplementationOnce(
          () =>
            new Promise<SessionInfo>((resolve) => {
              settle = () => resolve({ ...session.native, permissions });
            }),
        );
      const remote = await prepareV2RemoteWorkspace({
        runtime,
        timeoutMs: 25,
        profileRoot: runtime.options.config.profileRoot,
        visibilityInvocationConformance: true,
        workspaceTarget: { executionTargetId: "ssh:synthetic" } as WorkspaceTarget,
        httpConfig: {
          host: "127.0.0.1",
          port: 1,
          token: "synthetic-only",
          threadId,
          providerSessionId: session.native.id,
        },
      });
      await expect(remote.install(session)).rejects.toThrow("timed out");
      expect(cleanup).toHaveBeenCalled();
      expect(bridgeAlive).toBe(false);
      const updates = update.mock.calls.length;
      await expect(remote.install(session)).rejects.toThrow("quarantined");
      await expect(remote.cleanup()).rejects.toThrow("quarantined");
      await expect(
        runtime.send({
          threadId,
          modelSelection,
          requestMessageId: MessageId.makeUnsafe("blocked"),
          input: "blocked",
        }),
      ).rejects.toThrow("quarantined");
      await expect(
        runtime.start({
          threadId: ThreadId.makeUnsafe("rebind"),
          modelSelection,
          cwd: directory,
          runtimeMode: "approval-required",
        }),
      ).rejects.toThrow("quarantined");
      expect(update.mock.calls).toHaveLength(updates);
      expect(remove).not.toHaveBeenCalled();
      settle();
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Intended late installation is NOT safety proof after the bridge lease was revoked.
      expect(() => runtime.mutations.assertSafe()).toThrow("quarantined");
      expect(bridgeAlive && names.size > 0).toBe(false);
      // Only authoritative rollback (absent server AND deny-only permissions) can discharge.
      names.clear();
      permissions = [{ action: "*", resource: "*", effect: "deny" }];
      runtime.mutations.retryVerification();
      await expect
        .poll(() => {
          try {
            runtime.mutations.assertSafe();
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      await expect(
        runtime.send({
          threadId,
          modelSelection,
          requestMessageId: MessageId.makeUnsafe("still-blocked"),
          input: "blocked",
        }),
      ).rejects.toThrow("cleanup must be verified");
      await remote.cleanup();
      expect(get).toHaveBeenCalled();
      expect(remove).toHaveBeenCalledTimes(1);
      expect(http.calls.some((call) => call.pathname.endsWith("/prompt"))).toBe(false);
      await expect(remote.install(session)).rejects.toThrow("ownership rejected");
    });
  });
