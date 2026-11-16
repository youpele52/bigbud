import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SidebarRemoteAgentInstallDialog } from "./SidebarRemoteAgentInstallDialog";
import type { SidebarRemoteAgentInstallRequest } from "./Sidebar.remoteWorkspaceAddActions.types";

const api = vi.hoisted(() => ({ current: null as never }));
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => api.current }));

const command = "curl -fsSL https://bigbud.app/remote-agent.sh | BIGBUD_AGENT_VERSION=0.3.4 sh";

function request(): SidebarRemoteAgentInstallRequest {
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
      connectionSource: "manual",
      inactiveConnection: { host: "", username: "", port: "", sshKeyPath: "", authMode: "ssh-key" },
    },
    executionTargetId: `ssh:example?transport=agent&test=${crypto.randomUUID()}`,
    targetLabel: "example",
  };
}

describe("SidebarRemoteAgentInstallDialog manual placement", () => {
  it("offers the pinned remote command proactively and finishes through the install action", async () => {
    const target = request();
    const getRemoteAgentManualInstall = vi.fn().mockResolvedValue({
      executionTargetId: target.executionTargetId,
      version: "0.3.4",
      command,
      scriptUrl: "https://bigbud.app/remote-agent.sh",
      releaseScriptUrl:
        "https://github.com/youpele52/bigbud/releases/download/v0.3.4/remote-agent.sh",
      inboxRelativePath: "~/.bigbud/agent/inbox",
    });
    const installRemoteAgent = vi.fn().mockResolvedValue({
      message:
        "Update 0.3.4 staged from the agent you placed on the remote host. It will be used on your next new connection.",
    });
    api.current = { server: { getRemoteAgentManualInstall, installRemoteAgent } } as never;
    await render(
      <SidebarRemoteAgentInstallDialog
        request={target}
        onDecline={vi.fn()}
        onInstalled={vi.fn()}
      />,
    );
    await expect.element(page.getByRole("button", { name: "Download update" })).toBeEnabled();
    await page.getByRole("button", { name: "Copy remote command" }).click();
    await expect.element(page.getByText(command)).toBeVisible();
    await expect.element(page.getByText(/Nothing is active until you return here/)).toBeVisible();
    expect(getRemoteAgentManualInstall).toHaveBeenCalledExactlyOnceWith({
      executionTargetId: target.executionTargetId,
    });
    await page.getByRole("button", { name: "Finish install/update" }).click();
    await expect
      .element(page.getByText(/staged from the agent you placed on the remote host/))
      .toBeVisible();
    expect(installRemoteAgent).toHaveBeenCalledExactlyOnceWith({
      executionTargetId: target.executionTargetId,
    });
    await expect.element(page.getByRole("button", { name: "Connect new session" })).toBeEnabled();
  });

  it("reports a command preparation failure without blocking automatic install", async () => {
    api.current = {
      server: {
        getRemoteAgentManualInstall: vi.fn().mockRejectedValue(new Error("Source unavailable")),
        installRemoteAgent: vi.fn(),
      },
    } as never;
    await render(
      <SidebarRemoteAgentInstallDialog
        request={request()}
        onDecline={vi.fn()}
        onInstalled={vi.fn()}
      />,
    );
    await page.getByRole("button", { name: "Copy remote command" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Source unavailable");
    await expect.element(page.getByRole("button", { name: "Download update" })).toBeEnabled();
  });
});
