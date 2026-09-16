import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SidebarRemoteAgentInstallDialog } from "./SidebarRemoteAgentInstallDialog";
import type { SidebarRemoteAgentInstallRequest } from "./Sidebar.projectAddActions.remote.types";

const api = vi.hoisted(() => ({ current: null as never }));
const toast = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => api.current }));
vi.mock("../ui/toast.manager", () => ({ toastManager: toast }));
afterEach(() => toast.add.mockClear());

function installRequest(): SidebarRemoteAgentInstallRequest {
  return {
    kind: "install",
    candidate: {
      displayName: "Remote",
      host: "example",
      username: "",
      port: "",
      workspaceRoot: "/workspace",
      sshKeyPath: "",
      authMode: "ssh-key",
      remoteTransport: "agent",
      providerRuntimeLocation: "remote",
    },
    executionTargetId: `ssh:example?transport=agent&test=${crypto.randomUUID()}`,
    targetLabel: "example",
  };
}

describe("SidebarRemoteAgentInstallDialog", () => {
  it("warns when setup connects using the prior healthy agent", async () => {
    const request = installRequest();
    api.current = {
      server: {
        installRemoteAgent: vi.fn().mockResolvedValue({ message: "Update staged." }),
        connectRemoteAgent: vi.fn().mockResolvedValue({
          connectionId: crypto.randomUUID(),
          outcome: "fallback",
          currentVersion: "0.2.209",
          requestedVersion: "0.2.210",
          warning: "The update failed its health check.",
          pendingVersion: null,
          fallbackVersion: null,
        }),
      },
    } as never;
    const onInstalled = vi.fn().mockResolvedValue(undefined);
    await render(
      <SidebarRemoteAgentInstallDialog
        request={request}
        onDecline={vi.fn()}
        onInstalled={onInstalled}
      />,
    );
    await page.getByRole("button", { name: "Download update" }).click();
    await page.getByRole("button", { name: "Connect new session" }).click();
    await vi.waitFor(() => expect(onInstalled).toHaveBeenCalledOnce());
    expect(toast.add).toHaveBeenCalledExactlyOnceWith({
      type: "warning",
      title: "Remote agent update unavailable",
      description:
        "Could not use agent 0.2.210. Connected using healthy agent 0.2.209. The update failed its health check.",
    });
    expect(onInstalled).toHaveBeenCalledWith(expect.stringContaining("healthy agent 0.2.209"));
    expect(request.candidate.remoteTransport).toBe("agent");
  });

  it("keeps setup open after a download failure and offers manual Direct SSH without changing the target", async () => {
    const request = installRequest();
    const installRemoteAgent = vi.fn().mockRejectedValue(new Error("Checksum verification failed"));
    const connectRemoteAgent = vi.fn();
    api.current = { server: { installRemoteAgent, connectRemoteAgent } } as never;
    const onDecline = vi.fn();
    const onInstalled = vi.fn();
    await render(
      <SidebarRemoteAgentInstallDialog
        request={request}
        onDecline={onDecline}
        onInstalled={onInstalled}
      />,
    );
    await page.getByRole("button", { name: "Download update" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Checksum verification failed");
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("choose Direct SSH in Connection method to switch manually");
    expect(installRemoteAgent).toHaveBeenCalledExactlyOnceWith({
      executionTargetId: request.executionTargetId,
    });
    expect(request.candidate.remoteTransport).toBe("agent");
    expect(connectRemoteAgent).not.toHaveBeenCalled();
    expect(onDecline).not.toHaveBeenCalled();
    expect(onInstalled).not.toHaveBeenCalled();
    await expect.element(page.getByRole("button", { name: "Download update" })).toBeEnabled();
  });

  it("waits for runtime preparation and health verification before reporting a connection", async () => {
    const request = installRequest();
    let resolveConnection: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      resolveConnection = resolve;
    });
    const installRemoteAgent = vi.fn().mockResolvedValue({ message: "Update staged." });
    const connectRemoteAgent = vi.fn().mockImplementation(async () => {
      await completion;
      return { connectionId: "ready", currentVersion: "0.2.209", fallbackVersion: null };
    });
    api.current = { server: { installRemoteAgent, connectRemoteAgent } } as never;
    const onInstalled = vi.fn().mockResolvedValue(undefined);
    await render(
      <SidebarRemoteAgentInstallDialog
        request={request}
        onDecline={vi.fn()}
        onInstalled={onInstalled}
      />,
    );
    await expect.element(page.getByText(/may be prepared in the background/)).toBeVisible();
    await page.getByRole("button", { name: "Download update" }).click();
    await page.getByRole("button", { name: "Connect new session" }).click();
    await expect
      .element(page.getByRole("button", { name: "Preparing and connecting..." }))
      .toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Later" })).toBeDisabled();
    expect(onInstalled).not.toHaveBeenCalled();
    expect(connectRemoteAgent).toHaveBeenCalledExactlyOnceWith({
      executionTargetId: request.executionTargetId,
      requestId: expect.any(String),
      intent: "fresh",
    });
    expect(request.candidate.remoteTransport).toBe("agent");
    resolveConnection?.();
    await vi.waitFor(() => expect(onInstalled).toHaveBeenCalledOnce());
    expect(toast.add).not.toHaveBeenCalled();
  });

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
            remoteTransport: "agent",
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
            remoteTransport: "agent",
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
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("choose Direct SSH in Connection method to switch manually");
    await page.getByRole("button", { name: "Connect new session" }).click();
    await vi.waitFor(() => expect(onInstalled).toHaveBeenCalledOnce());
    expect(connectRemoteAgent.mock.calls[0]?.[0].requestId).toBe(
      connectRemoteAgent.mock.calls[1]?.[0].requestId,
    );
    expect(connectRemoteAgent.mock.calls[0]?.[0].intent).toBe("fresh");
  });
});
