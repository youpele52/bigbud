import { ProjectId } from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "../../models/types";
import { useStore } from "../main";
import { useRemoteAccessStore } from "./remoteAccess.store";

const api = vi.hoisted(() => ({
  server: {
    restartRemoteAgent: vi.fn(),
    getRemoteAgentRestartStatus: vi.fn(),
    disconnectExecutionTarget: vi.fn(),
    connectExecutionTarget: vi.fn(),
    verifyExecutionTarget: vi.fn(),
  },
}));
const toast = vi.hoisted(() => ({ add: vi.fn(() => "toast"), close: vi.fn(), update: vi.fn() }));
const activity = vi.hoisted(() => ({ activeTurnCount: 0, runningTerminalCount: 0 }));
const stored = vi.hoisted(() => ({
  requests: [] as Array<{ requestId: string; projectId: string }>,
}));
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => api }));
vi.mock("../../components/ui/toast", () => ({ toastManager: toast }));
vi.mock("./remoteTargetActions.persistence", () => ({
  readReconnectRequests: () => stored.requests,
  saveReconnectRequest: (request: { requestId: string; projectId: string }) => {
    stored.requests = [
      ...stored.requests.filter((r) => r.requestId !== request.requestId),
      request,
    ];
  },
  removeReconnectRequest: (requestId: string) => {
    stored.requests = stored.requests.filter((r) => r.requestId !== requestId);
  },
}));
vi.mock(
  "../../components/sidebar/Sidebar.projectActions.connection.logic",
  async (importActual) => ({
    ...(await importActual<object>()),
    summarizeExecutionTargetActivity: () => ({ ...activity, sharedWorkspaceNames: [] }),
  }),
);

import {
  confirmDisconnect,
  requestConnect,
  requestDisconnect,
} from "./remoteTargetActions.connection";
import { runRemoteTargetMenuAction } from "./remoteTargetActions.menu";
import {
  confirmReconnect,
  dismissReconnect,
  requestReconnect,
} from "./remoteTargetActions.reconnect";
import { isReconnectPending, useRemoteTargetActionsStore } from "./remoteTargetActions.store";

const SSH = "ssh:host=ice-2-kg&user=root&auth=password";
const project = (id: string, target: string) =>
  ({
    id: ProjectId.makeUnsafe(id),
    name: id,
    cwd: "/srv/app",
    workspaceExecutionTargetId: target,
    defaultModelSelection: null,
    scripts: [],
  }) as unknown as Project;
const REMOTE = project("remote", SSH);
const LOCAL = project("local", "local");

describe("shared remote target actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stored.requests = [];
    activity.activeTurnCount = 0;
    useStore.setState({ projects: [REMOTE, LOCAL], sidebarThreadsById: {} });
    useRemoteTargetActionsStore.setState({
      pendingReconnect: null,
      pendingDisconnect: null,
      activeReconnectRequestIds: {},
    });
    useRemoteAccessStore.setState({
      verifiedExecutionTargetIds: {},
      disconnectedExecutionTargetIds: {},
      disconnectedTargetsLoaded: true,
      executionTargetChecks: {},
    });
    useRemoteAccessStore.getState().clearAuthDialog();
  });

  it("Reconnect asks for confirmation (SSH only), then restarts the remote service once", async () => {
    requestReconnect(LOCAL.id);
    expect(useRemoteTargetActionsStore.getState().pendingReconnect).toBeNull();
    requestReconnect(REMOTE.id);
    expect(useRemoteTargetActionsStore.getState().pendingReconnect).toMatchObject({
      projectId: REMOTE.id,
      projectName: "remote",
    });
    expect(isReconnectPending(REMOTE.id)).toBe(true);
    api.server.restartRemoteAgent.mockResolvedValue({ phase: "ready", message: "Ready." });

    await confirmReconnect();

    expect(api.server.restartRemoteAgent).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: REMOTE.id, expectedWorkspaceExecutionTargetId: SSH }),
    );
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: 'Reconnected "remote"' }),
    );
    expect(isReconnectPending(REMOTE.id)).toBe(false);
    expect(stored.requests).toEqual([]);
  });

  it("dismissing the confirmation starts nothing", () => {
    requestReconnect(REMOTE.id);
    dismissReconnect();
    expect(useRemoteTargetActionsStore.getState().pendingReconnect).toBeNull();
    expect(api.server.restartRemoteAgent).not.toHaveBeenCalled();
  });

  it("a restart that needs the SSH password opens the global auth dialog; cancel forgets it", async () => {
    api.server.restartRemoteAgent.mockRejectedValue(
      new Error(
        "SSH password is required for root@ice-2-kg. Re-enter it before using this target.",
      ),
    );
    requestReconnect(REMOTE.id);
    await confirmReconnect();
    const auth = useRemoteAccessStore.getState();
    expect(auth.isAuthDialogOpen).toBe(true);
    expect(auth.authMode).toBe("password");
    expect(auth.pendingAction?.executionTargetId).toBe(SSH);
    auth.closeAuthDialog();
    expect(stored.requests).toEqual([]);
    expect(isReconnectPending(REMOTE.id)).toBe(false);
  });

  it("Disconnect runs at once without running work, and confirms first when it would cut work off", async () => {
    api.server.disconnectExecutionTarget.mockResolvedValue(undefined);
    requestDisconnect(REMOTE.id);
    await vi.waitFor(() =>
      expect(api.server.disconnectExecutionTarget).toHaveBeenCalledWith({ executionTargetId: SSH }),
    );
    expect(useRemoteAccessStore.getState().disconnectedExecutionTargetIds[SSH]).toBe(true);

    vi.clearAllMocks();
    activity.activeTurnCount = 1;
    requestDisconnect(REMOTE.id);
    expect(api.server.disconnectExecutionTarget).not.toHaveBeenCalled();
    expect(useRemoteTargetActionsStore.getState().pendingDisconnect).toMatchObject({
      executionTargetId: SSH,
      activeTurnCount: 1,
    });
    await confirmDisconnect();
    expect(api.server.disconnectExecutionTarget).toHaveBeenCalledOnce();
    expect(useRemoteTargetActionsStore.getState().pendingDisconnect).toBeNull();
  });

  it("Connect clears the user disconnect and re-establishes access", async () => {
    vi.stubGlobal("window", globalThis);
    useRemoteAccessStore.getState().markExecutionTargetDisconnected(SSH);
    api.server.connectExecutionTarget.mockResolvedValue(undefined);
    api.server.verifyExecutionTarget.mockResolvedValue({ remoteAgent: null });

    await requestConnect(REMOTE.id);

    expect(api.server.connectExecutionTarget).toHaveBeenCalledWith({ executionTargetId: SSH });
    expect(api.server.verifyExecutionTarget).toHaveBeenCalledOnce();
    expect(useRemoteAccessStore.getState().disconnectedExecutionTargetIds[SSH]).toBeUndefined();
    expect(useRemoteAccessStore.getState().verifiedExecutionTargetIds[SSH]).toBe(true);
    vi.unstubAllGlobals();
  });

  it("menu glue routes only remote items", async () => {
    expect(await runRemoteTargetMenuAction("delete", REMOTE.id)).toBe(false);
    expect(await runRemoteTargetMenuAction("reconnect", REMOTE.id)).toBe(true);
    expect(useRemoteTargetActionsStore.getState().pendingReconnect?.projectId).toBe(REMOTE.id);
  });
});
