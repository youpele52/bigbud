import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { describe, expect, it, vi } from "vitest";
import { RemoteAgentManagementSection } from "./RemoteAgentManagementSection";

const fixture = vi.hoisted(() => ({
  install: vi.fn(),
  manual: vi.fn(),
  projects: [
    {
      id: "p1",
      name: "VPS",
      workspaceRoot: "/work",
      workspaceExecutionTargetId: "ssh:host=healthy&transport=agent",
    },
  ],
}));
vi.mock("../../stores/main/main.store", () => ({
  useStore: (select: (state: { projects: typeof fixture.projects }) => unknown) =>
    select({ projects: fixture.projects }),
}));
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({
    server: { installRemoteAgent: fixture.install, getRemoteAgentManualInstall: fixture.manual },
  }),
}));
vi.mock("../sidebar/SidebarRemoteAgentInstallDialog", () => ({
  SidebarRemoteAgentInstallDialog: ({ request }: { request: unknown }) =>
    request ? <p>Explicit stage and connect dialog</p> : null,
}));

describe("healthy saved remote management", () => {
  it.each(["deferred", "uncertain"])(
    "shows a pre-stage %s result without claiming failure or activation",
    async (outcome) => {
      fixture.install.mockResolvedValue({
        outcome,
        message: `${outcome}: remote operation has not confirmed activation.`,
      });
      await render(<RemoteAgentManagementSection />);
      await page.getByRole("button", { name: "Replace", exact: true }).click();
      await expect
        .element(page.getByRole("status"))
        .toHaveTextContent(`${outcome}: remote operation has not confirmed activation.`);
    },
  );

  it("exposes proactive manual staging and replacement with cleanup status", async () => {
    fixture.install.mockResolvedValue({
      outcome: "active",
      cleanupDeferred: true,
      message:
        "Agent 1 is active. Cleanup of older builds is deferred while live work still uses them.",
    });
    fixture.manual.mockResolvedValue({
      version: "1",
      command: "curl https://bigbud.app/remote-agent.sh | BIGBUD_AGENT_VERSION=1 sh",
      scriptUrl: "https://bigbud.app/remote-agent.sh",
      releaseScriptUrl: "https://example.test/script",
      inboxRelativePath: ".bigbud/agent/inbox",
    });
    await render(<RemoteAgentManagementSection />);
    await expect.element(page.getByRole("button", { name: "Replace", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Replace", exact: true }).click();
    expect(fixture.install).toHaveBeenCalledWith({
      executionTargetId: "ssh:host=healthy&transport=agent",
      replace: true,
    });
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Cleanup of older builds is deferred");
    await page.getByRole("button", { name: /remote command/i }).click();
    await expect.element(page.getByText(/BIGBUD_AGENT_VERSION=1/)).toBeVisible();
    await page.getByRole("button", { name: "Install / stage update" }).click();
    await expect.element(page.getByText("Explicit stage and connect dialog")).toBeVisible();
  });
});
