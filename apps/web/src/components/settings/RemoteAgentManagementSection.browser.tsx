import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRemoteAccessStore } from "../../stores/remoteAccess/remoteAccess.store";
import { RemoteAgentManagementSection } from "./RemoteAgentManagementSection";

const AGENT = "ssh:host=healthy&transport=agent";
const DIRECT = "ssh:host=direct&auth=ssh-key&transport=direct-ssh";
const OFFLINE = "ssh:host=aaa-offline&transport=agent";

const fixture = vi.hoisted(() => ({
  install: vi.fn(),
  manual: vi.fn(),
  remove: vi.fn(),
  projects: [] as Array<Record<string, unknown>>,
}));
vi.mock("../../stores/main/main.store", () => ({
  useStore: (select: (state: { projects: typeof fixture.projects }) => unknown) =>
    select({ projects: fixture.projects }),
}));
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({
    server: {
      installRemoteAgent: fixture.install,
      getRemoteAgentManualInstall: fixture.manual,
      removeRemoteAgent: fixture.remove,
    },
  }),
}));
vi.mock("../sidebar/SidebarRemoteAgentInstallDialog", () => ({
  SidebarRemoteAgentInstallDialog: ({ request }: { request: unknown }) =>
    request ? <p>Explicit stage and connect dialog</p> : null,
}));

const project = (id: string, target: string) => ({
  id,
  name: id,
  cwd: "/work",
  workspaceExecutionTargetId: target,
  defaultModelSelection: null,
  scripts: [],
});
/**
 * No stylesheet loads in these tests, so Base UI's unstyled inert layer sits over the open dialog
 * and intercepts pointer hits; dispatch the click to the dialog control directly.
 */
function clickInDialog(element: Element) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

const summary = { currentVersion: "0.4.0", pendingVersion: null, fallbackVersion: null };

beforeEach(() => {
  vi.resetAllMocks();
  fixture.projects = [project("VPS", AGENT)];
  useRemoteAccessStore.setState({
    remoteConnections: { [AGENT]: summary },
    verifiedExecutionTargetIds: {},
    disconnectedExecutionTargetIds: {},
    executionTargetChecks: {},
  });
});

describe("Settings → Remote agents", () => {
  it.each(["deferred", "uncertain"])(
    "shows a %s replacement without claiming failure or activation",
    async (outcome) => {
      fixture.install.mockResolvedValue({
        outcome,
        message: `${outcome}: remote operation has not confirmed activation.`,
      });
      await render(<RemoteAgentManagementSection />);
      await page.getByRole("button", { name: "Replace now", exact: true }).click();
      await expect
        .element(page.getByRole("status"))
        .toHaveTextContent(`${outcome}: remote operation has not confirmed activation.`);
    },
  );

  it("exposes the manual command, replacement with cleanup status and Finish install", async () => {
    fixture.install.mockResolvedValue({
      outcome: "active",
      cleanupDeferred: true,
      message:
        "Agent 1 is active. Cleanup of older builds is deferred while live work still uses them.",
    });
    fixture.manual.mockResolvedValue({
      version: "1",
      command: "curl -fsSL https://bigbud.app/download/v1/remote-agent | BIGBUD_AGENT_VERSION=1 sh",
      scriptUrl: "https://bigbud.app/download/v1/remote-agent",
      releaseScriptUrl: "https://github.com/youpele52/bigbud/releases/download/v1/remote-agent.sh",
      inboxRelativePath: "~/.bigbud/agent/inbox",
    });
    await render(<RemoteAgentManagementSection />);
    await expect.element(page.getByText("Remote agent · Agent 0.4.0 · 1 workspace")).toBeVisible();
    await page.getByRole("button", { name: "Replace now", exact: true }).click();
    expect(fixture.install).toHaveBeenCalledWith({ executionTargetId: AGENT, replace: true });
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Cleanup of older builds is deferred");
    await page.getByRole("button", { name: /remote command/i }).click();
    await expect.element(page.getByText(/download\/v1\/remote-agent \|/)).toBeVisible();
    await page.getByRole("button", { name: "Finish install", exact: true }).click();
    await expect.element(page.getByText("Explicit stage and connect dialog")).toBeVisible();
  });

  it("lists Direct SSH hosts and greys disconnected hosts at the bottom", async () => {
    fixture.projects = [
      project("Offline", OFFLINE),
      project("VPS", AGENT),
      project("Plain", DIRECT),
    ];
    useRemoteAccessStore.setState({
      verifiedExecutionTargetIds: { [DIRECT]: true, [OFFLINE]: true },
      disconnectedExecutionTargetIds: { [OFFLINE]: true },
    });
    await render(<RemoteAgentManagementSection />);
    const rows = page.getByTestId("remote-agent-host");
    await expect.element(rows.nth(0)).toHaveTextContent("direct");
    await expect.element(rows.nth(1)).toHaveTextContent("healthy");
    await expect.element(rows.nth(2)).toHaveTextContent("aaa-offline");
    await expect.element(rows.nth(2)).toHaveAttribute("data-connected", "false");
    await expect.element(rows.nth(2)).toHaveClass(/opacity-60/);
    await expect.element(rows.nth(2).getByText("Connect to manage")).toBeVisible();
    await expect
      .element(rows.nth(2).getByRole("button", { name: "Replace now", exact: true }))
      .toBeDisabled();
    await expect
      .element(rows.nth(0).getByRole("button", { name: "Install agent", exact: true }))
      .toBeEnabled();
  });

  it("hides Install agent on a Direct SSH host that has not connected this session", async () => {
    fixture.projects = [project("Plain", DIRECT)];
    useRemoteAccessStore.setState({ remoteConnections: {} });
    await render(<RemoteAgentManagementSection />);
    await expect.element(page.getByText("Connect to manage")).toBeVisible();
    expect(page.getByRole("button", { name: "Install agent" }).elements()).toHaveLength(0);
  });

  it("confirms removal with the Direct SSH switch on and lists blockers in amber", async () => {
    fixture.remove.mockResolvedValue({
      outcome: "blocked",
      blockers: [{ kind: "terminal", label: "Terminal in /work" }],
    });
    await render(<RemoteAgentManagementSection />);
    await page.getByRole("button", { name: "Remove agent", exact: true }).click();
    await expect
      .element(page.getByRole("checkbox", { name: "Switch these workspaces to Direct SSH" }))
      .toBeChecked();
    clickInDialog(
      page.getByRole("alertdialog").getByRole("button", { name: "Remove agent" }).element(),
    );
    expect(fixture.remove).toHaveBeenCalledWith({
      executionTargetId: AGENT,
      switchWorkspacesToDirectSsh: true,
    });
    const status = page.getByRole("status");
    await expect.element(status).toHaveTextContent("Nothing was removed.");
    await expect.element(status).toHaveTextContent("Terminal in /work");
    await expect.element(status).toHaveClass(/text-warning-foreground/);
  });

  it("reports a removal in green and marks the host disconnected", async () => {
    fixture.remove.mockResolvedValue({
      outcome: "removed",
      disconnected: 1,
      switchedWorkspaceIds: ["VPS"],
    });
    await render(<RemoteAgentManagementSection />);
    await page.getByRole("button", { name: "Remove agent", exact: true }).click();
    const toggle = page.getByRole("checkbox", { name: "Switch these workspaces to Direct SSH" });
    clickInDialog(page.getByText("Switch these workspaces to Direct SSH").element());
    await expect.element(toggle).not.toBeChecked();
    clickInDialog(
      page.getByRole("alertdialog").getByRole("button", { name: "Remove agent" }).element(),
    );
    expect(fixture.remove).toHaveBeenCalledWith({
      executionTargetId: AGENT,
      switchWorkspacesToDirectSsh: false,
    });
    const status = page.getByRole("status");
    await expect
      .element(status)
      .toHaveTextContent("Removed. Reconnect over SSH or the remote agent.");
    await expect.element(status).toHaveClass(/text-success-foreground/);
    expect(useRemoteAccessStore.getState().disconnectedExecutionTargetIds[AGENT]).toBe(true);
  });
});
