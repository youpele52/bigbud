import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import {
  mountHarness,
  project,
  resetApi,
  setApi,
  type CreateProject,
} from "./SidebarRemoteProjectDialog.browser.support";

describe("SidebarRemoteProjectDialog", () => {
  afterEach(resetApi);

  it("opens a prefilled edit dialog from the SSH project context menu", async () => {
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget: vi.fn(),
      getSnapshot: vi.fn(),
      dispatchCommand: vi.fn(),
    });
    await using _ = await mountHarness();

    await page.getByRole("button", { name: "Open project menu" }).click();

    await expect.element(page.getByRole("dialog")).toBeInTheDocument();
    await expect.element(page.getByText("Edit SSH remote project")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Host or IP")).toHaveValue("old-host");
    await expect.element(page.getByLabelText("Username")).toHaveValue("alice");
    await expect.element(page.getByLabelText("Port")).toHaveValue("2222");
    await expect.element(page.getByLabelText("Remote project path")).toHaveValue("/srv/project");
  });

  it("disables Save while the edit submission is pending", async () => {
    let resolveDispatch: (() => void) | undefined;
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget: vi.fn().mockResolvedValue({ message: "verified" }),
      getSnapshot: vi.fn().mockResolvedValue({ projects: [], threads: [] }),
      dispatchCommand: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveDispatch = resolve;
          }),
      ),
    });
    await using _ = await mountHarness();

    await page.getByRole("button", { name: "Open project menu" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect.element(page.getByRole("button", { name: "Saving..." })).toBeDisabled();
    resolveDispatch?.();
  });

  it("keeps the dialog open when a retained worktree fails verification", async () => {
    const dispatchCommand = vi.fn();
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget: vi
        .fn()
        .mockResolvedValueOnce({ message: "status verified" })
        .mockResolvedValueOnce({ message: "project verified" })
        .mockRejectedValueOnce(new Error("missing worktree")),
      getSnapshot: vi.fn().mockResolvedValue({
        projects: [],
        threads: [{ projectId: project.id, worktreePath: "/srv/worktree-a", deletedAt: null }],
      }),
      dispatchCommand,
    });
    await using _ = await mountHarness();

    await page.getByRole("button", { name: "Open project menu" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect.element(page.getByRole("dialog")).toBeInTheDocument();
    await expect
      .element(page.getByText(/The new SSH target cannot access these worktrees/))
      .toBeInTheDocument();
    expect(dispatchCommand).not.toHaveBeenCalled();
  });

  it("requires consent before installing the agent and leaves no project on No", async () => {
    const installRemoteAgent = vi.fn();
    const dispatchCommand = vi.fn();
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget: vi.fn().mockResolvedValue({
        message: "SSH verified; agent missing",
        remoteAgent: { status: "install-required" },
      }),
      installRemoteAgent,
      getSnapshot: vi.fn(),
      dispatchCommand,
    });
    await using _ = await mountHarness();

    await page.getByRole("button", { name: "Open project menu" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect.element(page.getByText("Download remote agent update")).toBeInTheDocument();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
    await expect.element(page.getByText("Download remote agent update")).not.toBeInTheDocument();
    expect(installRemoteAgent).not.toHaveBeenCalled();
    expect(dispatchCommand).not.toHaveBeenCalled();
  });

  it("does not create a new remote project when installation is declined", async () => {
    const createProject = vi.fn<CreateProject>();
    setApi({
      show: vi.fn(),
      verifyExecutionTarget: vi.fn().mockResolvedValue({
        message: "SSH verified; agent missing",
        remoteAgent: { status: "install-required" },
      }),
      getSnapshot: vi.fn(),
      dispatchCommand: vi.fn(),
    });
    await using _ = await mountHarness(createProject);

    await page.getByRole("button", { name: "Open add dialog" }).click();
    await page.getByLabelText("Host or IP").fill("remote.example.com");
    await page.getByLabelText("Remote project path").fill("/srv/project");
    await page.getByRole("button", { name: "Add remote project" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();

    expect(createProject).not.toHaveBeenCalled();
  });

  it("stages without updating the project until an explicit fresh connection", async () => {
    const installRemoteAgent = vi.fn().mockResolvedValue({
      message: "bigbud remote agent 1.2.3 was installed successfully.",
      version: "1.2.3",
    });
    const dispatchCommand = vi.fn().mockResolvedValue(undefined);
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget: vi.fn().mockResolvedValue({
        message: "SSH verified; agent missing",
        remoteAgent: { status: "install-required" },
      }),
      installRemoteAgent,
      connectRemoteAgent: vi.fn().mockResolvedValue({
        connectionId: "fresh",
        currentVersion: "1.2.3",
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
