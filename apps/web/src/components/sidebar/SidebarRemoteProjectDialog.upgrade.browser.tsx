import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import { mountHarness, resetApi, setApi } from "./SidebarRemoteProjectDialog.browser.support";

describe("SidebarRemoteProjectDialog remote-agent upgrades", () => {
  afterEach(resetApi);

  it("requires consent before upgrading an outdated remote agent", async () => {
    const installRemoteAgent = vi.fn();
    const dispatchCommand = vi.fn();
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget: vi.fn().mockResolvedValue({
        message: "SSH verified; agent upgrade required",
        remoteAgent: {
          status: "upgrade-required",
          currentVersion: "0.1.0",
          targetVersion: "0.2.0",
        },
      }),
      installRemoteAgent,
      getSnapshot: vi.fn(),
      dispatchCommand,
    });
    await using _ = await mountHarness();

    await page.getByRole("button", { name: "Open project menu" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect.element(page.getByText("Download remote agent update")).toBeInTheDocument();
    await expect
      .element(page.getByText(/Existing connections remain on their current runtime/))
      .toBeInTheDocument();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
    expect(installRemoteAgent).not.toHaveBeenCalled();
    expect(dispatchCommand).not.toHaveBeenCalled();
  });

  it("upgrades after consent before updating the remote project", async () => {
    const installRemoteAgent = vi.fn().mockResolvedValue({
      message: "bigbud remote agent 0.2.0 was installed successfully.",
      version: "0.2.0",
    });
    const dispatchCommand = vi.fn().mockResolvedValue(undefined);
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget: vi.fn().mockResolvedValue({
        message: "SSH verified; agent upgrade required",
        remoteAgent: {
          status: "upgrade-required",
          currentVersion: "0.1.0",
          targetVersion: "0.2.0",
        },
      }),
      installRemoteAgent,
      connectRemoteAgent: vi.fn().mockResolvedValue({
        connectionId: "fresh",
        currentVersion: "0.2.0",
        pendingVersion: null,
        fallbackVersion: null,
      }),
      getSnapshot: vi.fn().mockResolvedValue({ projects: [], threads: [] }),
      dispatchCommand,
    });
    await using _ = await mountHarness();

    await page.getByRole("button", { name: "Open project menu" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Download update" }).click();
    expect(dispatchCommand).not.toHaveBeenCalled();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Connect new session" })
      .click();

    await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalledOnce());
    expect(installRemoteAgent).toHaveBeenCalledOnce();
    expect(installRemoteAgent.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchCommand.mock.invocationCallOrder[0]!,
    );
  });
});
