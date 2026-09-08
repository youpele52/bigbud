import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SidebarRemoteAgentInstallDialog } from "./SidebarRemoteAgentInstallDialog";

const api = vi.hoisted(() => ({ current: null as never }));
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => api.current }));

describe("SidebarRemoteAgentInstallDialog", () => {
  it("describes a same-version rebuild as staging without replacing the serving runtime", async () => {
    await render(
      <SidebarRemoteAgentInstallDialog
        request={{
          kind: "upgrade",
          candidate: {
            displayName: "Remote project",
            host: "example",
            username: "",
            port: "",
            workspaceRoot: "/srv/project",
            sshKeyPath: "",
            authMode: "ssh-key",
            providerRuntimeLocation: "remote",
          },
          executionTargetId: "ssh:example",
          targetLabel: "example",
          currentVersion: "0.2.0",
          targetVersion: "0.2.0",
        }}
        onDecline={vi.fn()}
        onInstalled={vi.fn()}
      />,
    );

    await expect
      .element(page.getByText(/Existing connections remain on their current runtime/))
      .toBeVisible();
    expect(page.getByText(/from 0\.2\.0 to 0\.2\.0/).query()).toBeNull();
  });

  it("does not admit work at install completion and retries deliberate fresh admission with one identity", async () => {
    const installRemoteAgent = vi
      .fn()
      .mockResolvedValue({ version: "0.2.207", message: "Update staged." });
    const connectRemoteAgent = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporarily unreachable"))
      .mockResolvedValue({
        connectionId: "connection",
        currentVersion: "0.2.207",
        pendingVersion: null,
        fallbackVersion: "0.2.205",
      });
    api.current = { server: { installRemoteAgent, connectRemoteAgent } } as never;
    const onInstalled = vi.fn().mockResolvedValue(undefined);
    await render(
      <SidebarRemoteAgentInstallDialog
        request={{
          kind: "install",
          candidate: {
            displayName: "Remote",
            host: "example",
            username: "",
            port: "",
            workspaceRoot: "/workspace",
            sshKeyPath: "",
            authMode: "ssh-key",
            providerRuntimeLocation: "remote",
          },
          executionTargetId: "ssh:example",
          targetLabel: "example",
        }}
        onDecline={vi.fn()}
        onInstalled={onInstalled}
      />,
    );
    await page.getByRole("button", { name: "Download update" }).click();
    await expect.element(page.getByText("Update staged.")).toBeVisible();
    expect(connectRemoteAgent).not.toHaveBeenCalled();
    expect(onInstalled).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Connect new session" }).click();
    await expect.element(page.getByText("temporarily unreachable")).toBeVisible();
    await page.getByRole("button", { name: "Connect new session" }).click();
    await vi.waitFor(() => expect(onInstalled).toHaveBeenCalledOnce());
    expect(connectRemoteAgent.mock.calls[0]?.[0].requestId).toBe(
      connectRemoteAgent.mock.calls[1]?.[0].requestId,
    );
    expect(connectRemoteAgent.mock.calls[0]?.[0].intent).toBe("fresh");
  });
});
