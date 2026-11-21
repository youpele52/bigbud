import "../../index.css";

import { ProjectId } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import type { Project } from "../../models/types";
import { useStore } from "../../stores/main";
import { useRemoteAccessStore } from "../../stores/remoteAccess/remoteAccess.store";
import { requestDisconnect } from "../../stores/remoteAccess/remoteTargetActions.connection";
import { requestReconnect } from "../../stores/remoteAccess/remoteTargetActions.reconnect";
import { useRemoteTargetActionsStore } from "../../stores/remoteAccess/remoteTargetActions.store";

const mocks = vi.hoisted(() => ({
  api: {
    server: {
      restartRemoteAgent: vi.fn(),
      getRemoteAgentRestartStatus: vi.fn(),
      disconnectExecutionTarget: vi.fn(),
    },
  },
}));
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => mocks.api }));
vi.mock("../sidebar/Sidebar.projectActions.connection.logic", async (importActual) => ({
  ...(await importActual<object>()),
  shouldConfirmDisconnect: () => true,
}));

import { RemoteTargetDialogsHost } from "./RemoteTargetDialogsHost";

const SSH = "ssh:host=ice-2-kg&user=root&auth=password";
const project = {
  id: ProjectId.makeUnsafe("project-dialogs-host"),
  name: "Remote box",
  cwd: "/srv/app",
  workspaceExecutionTargetId: SSH,
  defaultModelSelection: null,
  scripts: [],
} as unknown as Project;

describe("RemoteTargetDialogsHost (sidebar not mounted, e.g. mobile)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useStore.setState({ projects: [project], sidebarThreadsById: {} });
    useRemoteTargetActionsStore.setState({
      pendingReconnect: null,
      pendingDisconnect: null,
      activeReconnectRequestIds: {},
    });
    useRemoteAccessStore.getState().clearAuthDialog();
  });
  afterEach(async () => {
    await cleanup();
    document.body.innerHTML = "";
  });

  it("renders the Reconnect confirmation and restarts the remote service on confirm", async () => {
    mocks.api.server.restartRemoteAgent.mockResolvedValue({ phase: "ready", message: "Ready." });
    await render(<RemoteTargetDialogsHost />);
    requestReconnect(project.id);
    await expect.element(page.getByText('Reconnect "Remote box"?')).toBeVisible();
    await expect.element(page.getByText(/restarts the bigbud remote service/)).toBeVisible();
    await page.getByRole("button", { name: "Reconnect" }).click();
    await vi.waitFor(() => expect(mocks.api.server.restartRemoteAgent).toHaveBeenCalledOnce());
  });

  it("renders the Disconnect confirmation", async () => {
    await render(<RemoteTargetDialogsHost />);
    requestDisconnect(project.id);
    await expect.element(page.getByText('Disconnect "Remote box"?')).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(useRemoteTargetActionsStore.getState().pendingDisconnect).toBeNull();
    expect(mocks.api.server.disconnectExecutionTarget).not.toHaveBeenCalled();
  });

  it("renders the SSH password prompt for any entry point", async () => {
    await render(<RemoteTargetDialogsHost />);
    useRemoteAccessStore.getState().openAuthDialog({
      pendingAction: { executionTargetId: SSH, onVerified: () => undefined },
      authMode: "password",
      promptLabel: "root@ice-2-kg",
    });
    await expect.element(page.getByText("Enter SSH password")).toBeVisible();
  });
});
