import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import {
  mountHarness,
  project,
  resetApi,
  setApi,
  type CreateProject,
} from "./SidebarRemoteProjectDialog.browser.support";

const hostsResult = {
  machineName: "macbook",
  hosts: [
    {
      alias: "work-server",
      sourcePath: "~/.ssh/config",
      line: 12,
      hostName: "10.0.4.7",
      user: "deploy",
    },
    { alias: "gpu-box", sourcePath: "~/.ssh/config.d/lab", line: 3 },
  ],
  sources: [{ path: "~/.ssh/config", kind: "user", status: "loaded" }],
};

const aliasProject = {
  ...project,
  workspaceExecutionTargetId: "ssh:host=work-server&auth=ssh-key&transport=direct-ssh",
};

function baseApi(overrides: Partial<Parameters<typeof setApi>[0]> = {}) {
  setApi({
    show: vi.fn().mockResolvedValue("edit-ssh"),
    verifyExecutionTarget: vi.fn().mockResolvedValue({ message: "SSH verified" }),
    getSnapshot: vi.fn().mockResolvedValue({ projects: [], threads: [] }),
    dispatchCommand: vi.fn().mockResolvedValue(undefined),
    listSshConfigHosts: vi.fn().mockResolvedValue(hostsResult),
    ...overrides,
  });
}

describe("SidebarRemoteProjectDialog — SSH config source", () => {
  afterEach(() => {
    localStorage.removeItem("remote_project_connection_source");
    resetApi();
  });

  it("opens From SSH config first, with Direct SSH listed first and preselected", async () => {
    baseApi();
    await using _ = await mountHarness();

    await page.getByRole("button", { name: "Open add dialog" }).click();

    const sources = page.getByRole("group", { name: "Connection source" }).getByRole("button");
    await expect.element(sources.first()).toHaveTextContent("From SSH config");
    await expect.element(sources.first()).toHaveAttribute("aria-pressed", "true");
    const methods = page.getByRole("group", { name: "Connection method" }).getByRole("button");
    await expect.element(methods.first()).toHaveTextContent(/Direct SSH/u);
    await expect.element(methods.first()).toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByText("Provider runtime", { exact: true })).toBeInTheDocument();
  });

  it("creates a project from a picked alias with the shared options still shown", async () => {
    const createProject = vi.fn<CreateProject>().mockResolvedValue({ ok: true });
    const verifyExecutionTarget = vi.fn().mockResolvedValue({ message: "SSH verified" });
    const listSshConfigHosts = vi.fn().mockResolvedValue(hostsResult);
    baseApi({ verifyExecutionTarget, listSshConfigHosts });
    await using _ = await mountHarness(createProject);

    await page.getByRole("button", { name: "Open add dialog" }).click();
    await expect.element(page.getByRole("button", { name: "Choose an SSH host" })).toBeVisible();
    await page.getByRole("button", { name: "Reload SSH config" }).click();
    await vi.waitFor(() => expect(listSshConfigHosts).toHaveBeenCalledTimes(2));
    await page.getByRole("button", { name: "Choose an SSH host" }).click();
    await page.getByPlaceholder("Search hosts").fill("work");
    await expect
      .element(page.getByRole("menuitemradio", { name: /gpu-box/u }))
      .not.toBeInTheDocument();
    await page.getByRole("menuitemradio", { name: /work-server/u }).click();
    await expect.element(page.getByRole("button", { name: "SSH host: work-server" })).toBeVisible();
    await page.getByLabelText("Remote project path").fill("/srv/app");

    await expect.element(page.getByText("Connection method", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Provider runtime", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText(/Read from the SSH config on macbook/u)).toBeVisible();
    await page.getByRole("button", { name: "Add remote project" }).click();

    await vi.waitFor(() => expect(createProject).toHaveBeenCalledOnce());
    const target = "ssh:host=work-server&auth=ssh-key&transport=direct-ssh";
    expect(verifyExecutionTarget).toHaveBeenCalledWith({
      executionTargetId: target,
      cwd: "/srv/app",
    });
    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceExecutionTargetId: target }),
    );
  });

  it("offers manual entry when no hosts are found and restores the typed host", async () => {
    baseApi({
      listSshConfigHosts: vi.fn().mockResolvedValue({ ...hostsResult, hosts: [] }),
    });
    await using _ = await mountHarness();

    await page.getByRole("button", { name: "Open add dialog" }).click();
    await expect.element(page.getByText(/No hosts found in the SSH config/u)).toBeVisible();
    await page.getByRole("button", { name: "Enter manually" }).last().click();
    await page.getByLabelText("Host or IP").fill("10.1.2.3");
    await page.getByRole("button", { name: "From SSH config" }).click();
    await page.getByRole("button", { name: "Enter manually" }).first().click();

    await expect.element(page.getByLabelText("Host or IP")).toHaveValue("10.1.2.3");
    expect(localStorage.getItem("remote_project_connection_source")).toContain("manual");
  });

  it("opens an untouched alias project in SSH config mode", async () => {
    baseApi();
    await using _ = await mountHarness(undefined, aliasProject);

    await page.getByRole("button", { name: "Open project menu" }).click();

    await expect
      .element(page.getByRole("button", { name: "From SSH config" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByRole("button", { name: "SSH host: work-server" })).toBeVisible();
  });

  it("keeps a save that started before hosts loaded", async () => {
    const pendingHosts: { resolve?: (value: typeof hostsResult) => void } = {};
    const dispatchCommand = vi.fn().mockResolvedValue(undefined);
    const verifyExecutionTarget = vi.fn().mockResolvedValue({ message: "SSH verified" });
    baseApi({
      dispatchCommand,
      verifyExecutionTarget,
      listSshConfigHosts: vi.fn(
        () =>
          new Promise<typeof hostsResult>((resolve) => {
            pendingHosts.resolve = resolve;
          }),
      ),
    });
    await using _ = await mountHarness(undefined, aliasProject);

    await page.getByRole("button", { name: "Open project menu" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    pendingHosts.resolve?.(hostsResult);

    await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalledOnce());
    expect(verifyExecutionTarget).toHaveBeenCalledWith({
      executionTargetId: aliasProject.workspaceExecutionTargetId,
      cwd: "/srv/project",
    });
  });
});
