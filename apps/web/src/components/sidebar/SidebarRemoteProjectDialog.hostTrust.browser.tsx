import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import {
  mountHarness,
  resetApi,
  setApi,
  type CreateProject,
} from "./SidebarRemoteProjectDialog.browser.support";

const challenge = {
  challengeId: "approval-1",
  host: "box (192.0.2.1)",
  keyType: "ED25519",
  fingerprint: "SHA256:abc123",
};
const unknownHost = new Error(`SSH host trust is required: ${JSON.stringify(challenge)}`);
const passwordRequired = new Error(
  "SSH password is required for box. Re-enter it before using this target.",
);

function configure(overrides: Partial<Parameters<typeof setApi>[0]>) {
  setApi({
    show: vi.fn(),
    verifyExecutionTarget: vi.fn(),
    getSnapshot: vi.fn(),
    dispatchCommand: vi.fn(),
    ...overrides,
  });
}

async function openAdd() {
  await page.getByRole("button", { name: "Open add dialog" }).click();
  await page
    .getByRole("group", { name: "Connection source" })
    .getByRole("button", { name: "Enter manually" })
    .click();
  await page.getByLabelText("Host or IP").fill("box");
  await page.getByLabelText("Remote project path").fill("/srv/app");
}

describe("remote project host trust", () => {
  afterEach(resetApi);

  it("reuses the secret dialog to show a fingerprint, then continues verification and saves", async () => {
    const createProject = vi.fn<CreateProject>().mockResolvedValue({ ok: true });
    const trustSshHost = vi.fn().mockResolvedValue({ message: "Trusted" });
    configure({
      trustSshHost,
      verifyExecutionTarget: vi
        .fn()
        .mockRejectedValueOnce(unknownHost)
        .mockResolvedValue({ message: "Connected" }),
    });
    await using _ = await mountHarness(createProject);
    await openAdd();
    await page.getByRole("button", { name: "Add remote project" }).click();
    await expect.element(page.getByRole("heading", { name: "Trust SSH server?" })).toBeVisible();
    await expect.element(page.getByText(challenge.fingerprint)).toBeVisible();
    await expect.element(page.getByText(challenge.host, { exact: true })).toBeVisible();
    await expect.element(page.getByLabelText("Key passphrase")).not.toBeInTheDocument();
    expect(trustSshHost).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Trust and connect" }).click();
    await vi.waitFor(() => expect(createProject).toHaveBeenCalledOnce());
    expect(trustSshHost).toHaveBeenCalledWith({
      executionTargetId: "ssh:host=box&auth=ssh-key&transport=direct-ssh",
      challengeId: challenge.challengeId,
    });
  });

  it("does not trust or save when host confirmation is canceled", async () => {
    const createProject = vi.fn<CreateProject>();
    const trustSshHost = vi.fn();
    configure({ trustSshHost, verifyExecutionTarget: vi.fn().mockRejectedValue(unknownHost) });
    await using _ = await mountHarness(createProject);
    await openAdd();
    await page.getByRole("button", { name: "Add remote project" }).click();
    const dialog = page
      .getByRole("dialog")
      .filter({ has: page.getByRole("heading", { name: "Trust SSH server?" }) });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(trustSshHost).not.toHaveBeenCalled();
    expect(createProject).not.toHaveBeenCalled();
  });

  it("preserves the folder-browsing continuation through trust and password unlock", async () => {
    const listRemoteFolders = vi
      .fn()
      .mockRejectedValueOnce(unknownHost)
      .mockRejectedValueOnce(passwordRequired)
      .mockResolvedValue({
        path: "/home/dev",
        homePath: "/home/dev",
        folders: [{ name: "notes", isGitRepo: false }],
        truncated: false,
      });
    const unlockSshPassword = vi.fn().mockResolvedValue({ message: "Unlocked" });
    configure({
      listRemoteFolders,
      trustSshHost: vi.fn().mockResolvedValue({ message: "Trusted" }),
      unlockSshPassword,
    });
    await using _ = await mountHarness();
    await openAdd();
    await page.getByRole("button", { name: "Browse" }).click();
    await page.getByRole("button", { name: "Trust and connect" }).click();
    await page.getByLabelText("SSH password", { exact: true }).fill("secret");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect.element(page.getByRole("button", { name: /notes/u })).toBeVisible();
    expect(unlockSshPassword).toHaveBeenCalledWith(expect.objectContaining({ password: "secret" }));
    expect(listRemoteFolders).toHaveBeenCalledTimes(3);
  });
});
