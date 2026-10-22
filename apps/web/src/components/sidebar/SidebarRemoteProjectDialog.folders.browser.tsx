import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import {
  mountHarness,
  resetApi,
  setApi,
  type CreateProject,
} from "./SidebarRemoteProjectDialog.browser.support";

const HOME = "/home/dev";
const TARGET = "ssh:host=box&auth=ssh-key&transport=direct-ssh";
const LOCKED = "SSH key '~/.ssh/id_lab' requires a passphrase. Load it into ssh-agent first.";

function listing(path: string, folders: Array<{ name: string; isGitRepo: boolean }>) {
  return { path, homePath: HOME, folders, truncated: false };
}

function baseApi(overrides: Partial<Parameters<typeof setApi>[0]> = {}) {
  setApi({
    show: vi.fn().mockResolvedValue("edit-ssh"),
    verifyExecutionTarget: vi.fn().mockResolvedValue({ message: "SSH verified" }),
    getSnapshot: vi.fn().mockResolvedValue({ projects: [], threads: [] }),
    dispatchCommand: vi.fn().mockResolvedValue(undefined),
    listRemoteFolders: vi.fn(async (input: { path?: string }) =>
      input.path === `${HOME}/api`
        ? listing(`${HOME}/api`, [])
        : listing(HOME, [
            { name: "api", isGitRepo: true },
            { name: "notes", isGitRepo: false },
          ]),
    ),
    ...overrides,
  });
}

async function openAddDialogWithHost() {
  await page.getByRole("button", { name: "Open add dialog" }).click();
  await page
    .getByRole("group", { name: "Connection source" })
    .getByRole("button", { name: "Enter manually" })
    .click();
  await page.getByLabelText("Host or IP").fill("box");
}

describe("SidebarRemoteProjectDialog — remote folders", () => {
  afterEach(() => {
    localStorage.removeItem("remote_project_connection_source");
    resetApi();
  });

  it("uses an optional Display name as the project title when given", async () => {
    const createProject = vi.fn<CreateProject>().mockResolvedValue({ ok: true });
    baseApi();
    await using _ = await mountHarness(createProject);

    await openAddDialogWithHost();
    await page.getByLabelText("Display name").fill("Lab API");
    await page.getByLabelText("Remote project path").fill("/srv/api");
    await page.getByRole("button", { name: "Add remote project" }).click();

    await vi.waitFor(() => expect(createProject).toHaveBeenCalledOnce());
    expect(createProject).toHaveBeenCalledWith(expect.objectContaining({ title: "Lab API" }));
  });

  it("browses over SSH from the home folder and fills the chosen folder", async () => {
    const createProject = vi.fn<CreateProject>().mockResolvedValue({ ok: true });
    const listRemoteFolders = vi.fn(async (input: { path?: string }) =>
      input.path ? listing(input.path, []) : listing(HOME, [{ name: "api", isGitRepo: true }]),
    );
    baseApi({ listRemoteFolders });
    await using _ = await mountHarness(createProject);

    await openAddDialogWithHost();
    await page.getByRole("button", { name: "Browse" }).click();
    await page.getByRole("button", { name: /api/u }).click();
    await page.getByRole("button", { name: "Use this folder" }).click();

    await expect.element(page.getByLabelText("Remote project path")).toHaveValue(`${HOME}/api`);
    expect(listRemoteFolders).toHaveBeenNthCalledWith(1, { executionTargetId: TARGET });
    expect(listRemoteFolders).toHaveBeenNthCalledWith(2, {
      executionTargetId: TARGET,
      path: `${HOME}/api`,
    });
    await page.getByRole("button", { name: "Add remote project" }).click();
    await vi.waitFor(() => expect(createProject).toHaveBeenCalledOnce());
    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({ rawCwd: `${HOME}/api`, title: "api (box)" }),
    );
  });

  it("warns when the home folder is chosen as the project", async () => {
    baseApi();
    await using _ = await mountHarness();

    await openAddDialogWithHost();
    await page.getByRole("button", { name: "Browse" }).click();
    await page.getByRole("button", { name: "Use this folder" }).click();

    await expect.element(page.getByText(/your whole home folder the project/u)).toBeVisible();
  });

  it("unlocks a passphrase-protected key and retries browsing", async () => {
    const unlockSshKey = vi.fn().mockResolvedValue({ message: "Unlocked." });
    const listRemoteFolders = vi
      .fn()
      .mockRejectedValueOnce(new Error(LOCKED))
      .mockResolvedValue(listing(HOME, [{ name: "notes", isGitRepo: false }]));
    baseApi({ listRemoteFolders, unlockSshKey });
    await using _ = await mountHarness();

    await openAddDialogWithHost();
    await page.getByRole("button", { name: "Browse" }).click();
    await page.getByLabelText("Key passphrase").fill("secret");
    await page.getByRole("button", { name: "Unlock SSH key" }).click();

    await expect.element(page.getByRole("button", { name: /notes/u })).toBeVisible();
    expect(unlockSshKey).toHaveBeenCalledWith({ executionTargetId: TARGET, passphrase: "secret" });
    expect(listRemoteFolders).toHaveBeenCalledTimes(2);
  });

  it("still verifies and saves after unlocking from verification", async () => {
    const createProject = vi.fn<CreateProject>().mockResolvedValue({ ok: true });
    const verifyExecutionTarget = vi
      .fn()
      .mockRejectedValueOnce(new Error(LOCKED))
      .mockResolvedValue({ message: "SSH verified" });
    baseApi({ verifyExecutionTarget, unlockSshKey: vi.fn().mockResolvedValue({ message: "ok" }) });
    await using _ = await mountHarness(createProject);

    await openAddDialogWithHost();
    await page.getByLabelText("Remote project path").fill("/srv/app");
    await page.getByRole("button", { name: "Add remote project" }).click();
    await page.getByLabelText("Key passphrase").fill("secret");
    await page.getByRole("button", { name: "Unlock SSH key" }).click();

    await vi.waitFor(() => expect(createProject).toHaveBeenCalledOnce());
    expect(verifyExecutionTarget).toHaveBeenCalledTimes(2);
  });
});
