import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import { mountHarness, resetApi, setApi } from "./SidebarRemoteWorkspaceDialog.browser.support";

const TARGET = "ssh:host=old-host&user=alice&port=2222&auth=ssh-key&transport=agent";
const upgradeRequired = {
  message: "SSH verified; agent upgrade required",
  remoteAgent: { status: "upgrade-required", currentVersion: "0.1.0", targetVersion: "0.2.0" },
};
const connected = {
  connectionId: "fresh",
  currentVersion: "0.2.0",
  pendingVersion: null,
  fallbackVersion: null,
};

function updateStatus(patch: Record<string, unknown>) {
  return {
    executionTargetId: TARGET,
    phase: "connected",
    updateRequestId: null,
    reconnectRequestId: null,
    reconnectOutcome: null,
    currentVersion: "0.2.0",
    pendingVersion: null,
    predecessorVersion: null,
    reason: null,
    ...patch,
  };
}

async function save() {
  await page.getByRole("button", { name: "Open project menu" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
}

describe("SidebarRemoteWorkspaceDialog Save installs the remote agent", () => {
  afterEach(resetApi);

  it("installs and connects without a confirmation dialog, then saves", async () => {
    const installRemoteAgent = vi.fn().mockResolvedValue({ message: "Agent 0.2.0 is active." });
    const connectRemoteAgent = vi.fn().mockResolvedValue(connected);
    const dispatchCommand = vi.fn().mockResolvedValue(undefined);
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget: vi.fn().mockResolvedValue(upgradeRequired),
      installRemoteAgent,
      connectRemoteAgent,
      getProjectWorktreePaths: vi.fn().mockResolvedValue({ worktreePaths: [], truncated: false }),
      dispatchCommand,
    });
    await using _ = await mountHarness();
    await save();

    await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalledOnce());
    expect(page.getByRole("alertdialog").elements()).toHaveLength(0);
    expect(installRemoteAgent).toHaveBeenCalledExactlyOnceWith({
      executionTargetId: TARGET,
      replace: true,
    });
    expect(connectRemoteAgent).toHaveBeenCalledWith(
      expect.objectContaining({ executionTargetId: TARGET, intent: "fresh", replace: true }),
    );
    expect(installRemoteAgent.mock.invocationCallOrder[0]).toBeLessThan(
      connectRemoteAgent.mock.invocationCallOrder[0]!,
    );
    expect(connectRemoteAgent.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchCommand.mock.invocationCallOrder[0]!,
    );
  });

  it("shows progress in blue and the cleanup outcome in green", async () => {
    let finishInstall!: (value: unknown) => void;
    const installRemoteAgent = vi.fn(() => new Promise((resolve) => (finishInstall = resolve)));
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget: vi.fn().mockResolvedValue(upgradeRequired),
      installRemoteAgent,
      connectRemoteAgent: vi.fn().mockResolvedValue({
        ...connected,
        cleanupMessage: "Older agent builds were removed.",
      }),
      // Keep the dialog open after install so the outcome stays visible.
      getProjectWorktreePaths: vi.fn(() => new Promise(() => undefined)),
      dispatchCommand: vi.fn(),
    });
    await using _ = await mountHarness();
    await save();

    const progress = page.getByText("Downloading verified agent…");
    await expect.element(progress).toBeVisible();
    await expect
      .element(page.getByRole("status").filter({ hasText: "Downloading verified agent…" }))
      .toHaveAttribute("data-status", "loading");
    finishInstall({ message: "Agent 0.2.0 is active." });
    const outcome = page
      .getByRole("status")
      .filter({ hasText: "Connected to remote agent 0.2.0. Older agent builds were removed." });
    await expect.element(outcome).toBeVisible();
    await expect.element(outcome).toHaveAttribute("data-status", "success");
  });

  it("skips install and connect when the identical verified build is active", async () => {
    const installRemoteAgent = vi.fn();
    const connectRemoteAgent = vi.fn();
    const dispatchCommand = vi.fn().mockResolvedValue(undefined);
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget: vi.fn().mockResolvedValue({
        message: "SSH verified",
        remoteAgent: { status: "ready", version: "0.2.0" },
      }),
      getRemoteAgentUpdateStatus: vi.fn().mockResolvedValue(
        updateStatus({
          phase: "ready-for-next-reconnect",
          pendingVersion: "0.2.0",
          currentTargetTriple: "x86_64-unknown-linux-musl",
          currentBuildDigestShort: "aaaaaaaaaaaa",
          pendingTargetTriple: "x86_64-unknown-linux-musl",
          pendingBuildDigestShort: "aaaaaaaaaaaa",
        }),
      ),
      installRemoteAgent,
      connectRemoteAgent,
      getProjectWorktreePaths: vi.fn().mockResolvedValue({ worktreePaths: [], truncated: false }),
      dispatchCommand,
    });
    await using _ = await mountHarness();
    await save();

    await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalledOnce());
    expect(installRemoteAgent).not.toHaveBeenCalled();
    expect(connectRemoteAgent).not.toHaveBeenCalled();
  });

  it("replaces when a different downloaded build waits for the next connect", async () => {
    const installRemoteAgent = vi.fn().mockResolvedValue({ message: "Agent 0.2.0 is active." });
    const dispatchCommand = vi.fn().mockResolvedValue(undefined);
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget: vi.fn().mockResolvedValue({
        message: "SSH verified",
        remoteAgent: { status: "ready", version: "0.2.0" },
      }),
      getRemoteAgentUpdateStatus: vi.fn().mockResolvedValue(
        updateStatus({
          phase: "ready-for-next-reconnect",
          pendingVersion: "0.2.0",
          currentTargetTriple: "x86_64-unknown-linux-gnu",
          currentBuildDigestShort: "aaaaaaaaaaaa",
          pendingTargetTriple: "x86_64-unknown-linux-musl",
          pendingBuildDigestShort: "bbbbbbbbbbbb",
        }),
      ),
      installRemoteAgent,
      connectRemoteAgent: vi.fn().mockResolvedValue(connected),
      getProjectWorktreePaths: vi.fn().mockResolvedValue({ worktreePaths: [], truncated: false }),
      dispatchCommand,
    });
    await using _ = await mountHarness();
    await save();

    await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalledOnce());
    expect(installRemoteAgent).toHaveBeenCalledOnce();
  });

  it("shows a failure in red with the manual command panel expanded and saves nothing", async () => {
    const dispatchCommand = vi.fn();
    const getRemoteAgentManualInstall = vi.fn().mockResolvedValue({
      executionTargetId: TARGET,
      version: "0.2.0",
      command:
        "curl -fsSL https://bigbud.app/download/v0.2.0/remote-agent | BIGBUD_AGENT_VERSION=0.2.0 sh",
      scriptUrl: "https://bigbud.app/download/v0.2.0/remote-agent",
      releaseScriptUrl:
        "https://github.com/youpele52/bigbud/releases/download/v0.2.0/remote-agent.sh",
      inboxRelativePath: "~/.bigbud/agent/inbox",
    });
    setApi({
      show: vi.fn().mockResolvedValue("edit-ssh"),
      verifyExecutionTarget: vi.fn().mockResolvedValue(upgradeRequired),
      installRemoteAgent: vi.fn().mockRejectedValue(new Error("GitHub download timed out.")),
      getRemoteAgentManualInstall,
      getProjectWorktreePaths: vi.fn(),
      dispatchCommand,
    });
    await using _ = await mountHarness();
    await save();

    await expect.element(page.getByText("GitHub download timed out.")).toBeVisible();
    await expect.element(page.getByText(/download\/v0\.2\.0\/remote-agent \|/)).toBeVisible();
    expect(getRemoteAgentManualInstall).toHaveBeenCalledWith({ executionTargetId: TARGET });
    expect(dispatchCommand).not.toHaveBeenCalled();
  });
});
