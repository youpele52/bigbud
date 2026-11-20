import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import {
  mountHarness,
  directSshProject,
  project,
  resetApi,
  setApi,
  type CreateProject,
} from "./SidebarRemoteWorkspaceDialog.browser.support";

describe("SidebarRemoteWorkspaceDialog", () => {
  afterEach(resetApi);

  it("opens a prefilled edit dialog from the SSH project context menu", async () => {
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget: vi.fn(),
      getProjectWorktreePaths: vi.fn(),
      dispatchCommand: vi.fn(),
    });
    await using _ = await mountHarness();

    await page.getByRole("button", { name: "Open project menu" }).click();

    await expect.element(page.getByRole("dialog")).toBeInTheDocument();
    await expect.element(page.getByText("Edit remote workspace")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Host or IP")).toHaveValue("old-host");
    await expect.element(page.getByLabelText("Username")).toHaveValue("alice");
    await expect.element(page.getByLabelText("Port")).toHaveValue("2222");
    await expect.element(page.getByLabelText("Remote workspace path")).toHaveValue("/srv/project");
    await expect
      .element(page.getByText(/The bigbud remote agent keeps remote terminals/u))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Use the bigbud remote agent. The agent must be installed on the remote host.",
        ),
      )
      .not.toBeInTheDocument();
  });

  it("explains where the agent goes only while the remote agent method is selected", async () => {
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget: vi.fn(),
      getProjectWorktreePaths: vi.fn(),
      dispatchCommand: vi.fn(),
    });
    await using _ = await mountHarness();
    await page.getByRole("button", { name: "Open project menu" }).click();

    const consent = page.getByText(
      "The agent is installed in ~/.bigbud/agent on the host and runs with your SSH user's permissions. It opens no network port. Saving installs or updates it; older versions are removed once nothing uses them.",
    );
    await expect.element(consent).toBeVisible();
    await expect.element(consent).toHaveClass(/text-xs/);
    await page.getByRole("button", { name: /^Direct SSH/ }).click();
    await expect.element(consent).not.toBeInTheDocument();
  });

  it("shows Direct SSH as the current connection for an existing Direct SSH project", async () => {
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget: vi.fn(),
      getProjectWorktreePaths: vi.fn(),
      dispatchCommand: vi.fn(),
    });
    await using _ = await mountHarness(undefined, directSshProject);

    await page.getByRole("button", { name: "Open project menu" }).click();

    const connection = page.getByRole("region", { name: "Remote connection" });
    await expect.element(connection).toHaveTextContent("Current connection");
    await expect.element(connection).toHaveTextContent("Direct SSH");
  });

  it("verifies a Direct SSH switch before saving the project", async () => {
    const verifyExecutionTarget = vi.fn().mockResolvedValue({ message: "SSH verified" });
    const dispatchCommand = vi.fn().mockResolvedValue(undefined);
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget,
      getProjectWorktreePaths: vi.fn().mockResolvedValue({ worktreePaths: [], truncated: false }),
      dispatchCommand,
    });
    await using _ = await mountHarness();

    await page.getByRole("button", { name: "Open project menu" }).click();
    await page.getByRole("button", { name: /Direct SSH/u }).click();
    await page.getByRole("button", { name: "Save changes" }).click();

    await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalledOnce());
    expect(verifyExecutionTarget).toHaveBeenCalledWith({
      executionTargetId: "ssh:host=old-host&user=alice&port=2222&auth=ssh-key&transport=direct-ssh",
      cwd: "/srv/project",
    });
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceExecutionTargetId:
          "ssh:host=old-host&user=alice&port=2222&auth=ssh-key&transport=direct-ssh",
      }),
    );
  });

  it("verifies a switch back to the bigbud remote agent before saving", async () => {
    const verifyExecutionTarget = vi.fn().mockResolvedValue({ message: "agent verified" });
    const dispatchCommand = vi.fn().mockResolvedValue(undefined);
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget,
      getProjectWorktreePaths: vi.fn().mockResolvedValue({ worktreePaths: [], truncated: false }),
      dispatchCommand,
    });
    await using _ = await mountHarness(undefined, directSshProject);

    await page.getByRole("button", { name: "Open project menu" }).click();
    await page.getByRole("button", { name: /bigbud remote agent/u }).click();
    await page.getByRole("button", { name: "Save changes" }).click();

    await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalledOnce());
    expect(verifyExecutionTarget).toHaveBeenCalledWith({
      executionTargetId: "ssh:host=old-host&user=alice&port=2222&auth=ssh-key&transport=agent",
      cwd: "/srv/project",
    });
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceExecutionTargetId:
          "ssh:host=old-host&user=alice&port=2222&auth=ssh-key&transport=agent",
      }),
    );
  });

  it("does not save a transport switch when verification fails", async () => {
    const dispatchCommand = vi.fn();
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget: vi.fn().mockRejectedValue(new Error("SSH host is unavailable")),
      getProjectWorktreePaths: vi.fn().mockResolvedValue({ worktreePaths: [], truncated: false }),
      dispatchCommand,
    });
    await using _ = await mountHarness();

    await page.getByRole("button", { name: "Open project menu" }).click();
    await page.getByRole("button", { name: /Direct SSH/u }).click();
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect.element(page.getByText("SSH host is unavailable")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
    expect(dispatchCommand).not.toHaveBeenCalled();
  });

  it("disables Save while the edit submission is pending", async () => {
    let resolveDispatch: (() => void) | undefined;
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget: vi.fn().mockResolvedValue({ message: "verified" }),
      getProjectWorktreePaths: vi.fn().mockResolvedValue({ worktreePaths: [], truncated: false }),
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
      getProjectWorktreePaths: vi.fn().mockResolvedValue({
        projectId: project.id,
        worktreePaths: ["/srv/worktree-a"],
        truncated: false,
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

  it("adds a workspace after installing the agent inline, with no confirmation dialog", async () => {
    const createProject = vi.fn<CreateProject>().mockResolvedValue({ ok: true });
    const installRemoteAgent = vi.fn().mockResolvedValue({ message: "Agent 1.2.3 is active." });
    setApi({
      show: vi.fn(),
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
      getProjectWorktreePaths: vi.fn(),
      dispatchCommand: vi.fn(),
    });
    await using _ = await mountHarness(createProject);

    await page.getByRole("button", { name: "Open add dialog" }).click();
    await page
      .getByRole("group", { name: "Connection source" })
      .getByRole("button", { name: "Enter manually" })
      .click();
    await page.getByLabelText("Host or IP").fill("remote.example.com");
    await page.getByLabelText("Remote workspace path").fill("/srv/project");
    await page.getByRole("button", { name: "Add remote workspace" }).click();

    await vi.waitFor(() => expect(createProject).toHaveBeenCalledOnce());
    expect(page.getByRole("alertdialog").elements()).toHaveLength(0);
    expect(installRemoteAgent.mock.invocationCallOrder[0]).toBeLessThan(
      createProject.mock.invocationCallOrder[0]!,
    );
  });

  it("does not create a new remote workspace when the agent install fails", async () => {
    const createProject = vi.fn<CreateProject>();
    setApi({
      show: vi.fn(),
      verifyExecutionTarget: vi.fn().mockResolvedValue({
        message: "SSH verified; agent missing",
        remoteAgent: { status: "install-required" },
      }),
      installRemoteAgent: vi.fn().mockRejectedValue(new Error("Unsupported CPU architecture.")),
      getProjectWorktreePaths: vi.fn(),
      dispatchCommand: vi.fn(),
    });
    await using _ = await mountHarness(createProject);

    await page.getByRole("button", { name: "Open add dialog" }).click();
    await page
      .getByRole("group", { name: "Connection source" })
      .getByRole("button", { name: "Enter manually" })
      .click();
    await page.getByLabelText("Host or IP").fill("remote.example.com");
    await page.getByLabelText("Remote workspace path").fill("/srv/project");
    await page.getByRole("button", { name: "Add remote workspace" }).click();

    await expect.element(page.getByText("Unsupported CPU architecture.")).toBeVisible();
    expect(createProject).not.toHaveBeenCalled();
  });
});
