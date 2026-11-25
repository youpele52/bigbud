import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import {
  mountHarness,
  project,
  resetApi,
  setApi,
} from "./SidebarRemoteWorkspaceDialog.browser.support";

const alias = "work-server";
const aliasProject = {
  ...project,
  workspaceExecutionTargetId: `ssh:host=${alias}&auth=ssh-key&transport=direct-ssh`,
};

const hostsResult = {
  machineName: "Rust SSH owner (development)",
  hosts: [
    {
      alias,
      sourcePath: "/private/tmp/bigbud-ssh-owner-dev-abc123/ssh-config",
      line: 5,
      hostName: "::1",
      user: "picker",
      port: "2200",
      hostKeyAlias: "workbench-trust",
      route: "via 1 hop",
    },
  ],
  sources: [],
};

describe("SidebarRemoteWorkspaceDialog — resolved owner host", () => {
  afterEach(() => resetApi());

  it("shows the resolved destination, login, port and route without credential paths", async () => {
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget: vi.fn().mockResolvedValue({ message: "SSH verified" }),
      getProjectWorktreePaths: vi.fn().mockResolvedValue({ worktreePaths: [], truncated: false }),
      dispatchCommand: vi.fn().mockResolvedValue(undefined),
      listSshConfigHosts: vi.fn().mockResolvedValue(hostsResult),
    });
    await using _ = await mountHarness(undefined, aliasProject);

    await page.getByRole("button", { name: "Open project menu" }).click();

    const selector = page.getByRole("button", { name: `SSH host: ${alias}` });
    await expect.element(selector).toBeVisible();
    await expect.element(selector).toHaveTextContent("::1");
    await expect.element(selector).toHaveTextContent("user picker");
    await expect.element(selector).toHaveTextContent("port 2200");
    await expect.element(selector).toHaveTextContent("via 1 hop");
    await expect.element(selector).not.toHaveTextContent("workbench-trust");
    await expect.element(selector).not.toHaveTextContent("IdentityFile");
  });
});
