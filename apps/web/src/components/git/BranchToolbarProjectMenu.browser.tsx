import "../../index.css";

import { ProjectId } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { useStore } from "../../stores/main";
import type { Project } from "../../models/types";

vi.mock("@tanstack/react-router", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock("../../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({ handleNewThread: vi.fn() }),
}));

vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => ({ sidebarThreadSortOrder: "updated" }),
}));

import BranchToolbarProjectMenu from "./BranchToolbarProjectMenu";
import { RemoteTargetDialogsHost } from "../remote/RemoteTargetDialogsHost";
import { useRemoteTargetActionsStore } from "../../stores/remoteAccess/remoteTargetActions.store";

const activeProject = {
  id: ProjectId.makeUnsafe("project-side-chat-selector"),
  name: "Selector project",
} as Project;

describe("BranchToolbarProjectMenu", () => {
  afterEach(async () => {
    await cleanup();
    document.body.innerHTML = "";
    useStore.setState({ projects: [], threads: [] });
    useRemoteTargetActionsStore.setState({ pendingReconnect: null, pendingDisconnect: null });
  });

  it("mounts with a stable standard-thread store snapshot", async () => {
    useStore.setState({ projects: [activeProject], threads: [] });

    await render(
      <BranchToolbarProjectMenu activeProject={activeProject} activeThreadId={undefined} />,
    );

    await expect.element(page.getByText("Selector project")).toBeInTheDocument();
  });

  it("shows Reconnect and Disconnect after an SSH workspace's threads and confirms from the global host", async () => {
    const remote = {
      id: ProjectId.makeUnsafe("project-remote-picker"),
      name: "Remote box",
      cwd: "/srv/app",
      workspaceExecutionTargetId: "ssh:host=ice-2-kg&user=root&auth=password",
    } as Project;
    useStore.setState({ projects: [activeProject, remote], threads: [] });

    await render(
      <>
        <BranchToolbarProjectMenu activeProject={activeProject} activeThreadId={undefined} />
        <RemoteTargetDialogsHost />
      </>,
    );
    await page.getByRole("button", { name: "Selector project" }).click();
    await page.getByRole("menuitem", { name: "Remote box" }).hover();
    const reconnect = page.getByRole("menuitem", { name: "Reconnect" });
    await expect.element(reconnect).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Disconnect" })).toBeVisible();
    const items = Array.from(document.querySelectorAll('[role="menuitem"]')).map(
      (item) => item.textContent?.trim() ?? "",
    );
    expect(items.indexOf("No recent threads")).toBeLessThan(items.indexOf("Reconnect"));
    expect(items.indexOf("Reconnect")).toBeLessThan(items.indexOf("Disconnect"));
    // A divider separates the thread list from the connection controls.
    const reconnectItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent?.trim() === "Reconnect",
    );
    expect(reconnectItem?.previousElementSibling?.getAttribute("role")).toBe("separator");

    await reconnect.click();
    await expect.element(page.getByText('Reconnect "Remote box"?')).toBeVisible();
  });

  it("adds no connection controls to a local project's submenu", async () => {
    const local = {
      id: ProjectId.makeUnsafe("project-local-picker"),
      name: "Local repo",
      cwd: "/repo",
    } as Project;
    useStore.setState({ projects: [activeProject, local], threads: [] });
    await render(
      <BranchToolbarProjectMenu activeProject={activeProject} activeThreadId={undefined} />,
    );
    await page.getByRole("button", { name: "Selector project" }).click();
    await page.getByRole("menuitem", { name: "Local repo" }).hover();
    await expect.element(page.getByText("No recent threads").first()).toBeVisible();
    expect(page.getByRole("menuitem", { name: "Reconnect" }).query()).toBeNull();
  });
});
