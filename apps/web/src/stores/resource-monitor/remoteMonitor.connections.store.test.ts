import { afterEach, describe, expect, it, vi } from "vitest";
import { useStore } from "~/stores/main/main.store";
import { useRemoteAccessStore } from "~/stores/remoteAccess/remoteAccess.store";
import { useRemoteMonitorStore } from "./remoteMonitor.store";
import { WsTransportDisconnectedError } from "~/rpc/wsTransport.errors";
import type { ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import {
  retainConnectedSshMonitorTargets,
  useConnectedSshMonitorStore,
} from "./remoteMonitor.connections.store";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("~/rpc/wsRpcClient", () => ({
  getWsRpcClient: () => ({ server: { listConnectedSshMonitors: rpc } }),
}));
const target = "ssh:host=demo&auth=ssh-key";
const discovered = { projectId: "saved-vps" as ProjectId, name: "Production", target };
afterEach(() => {
  vi.useRealTimers();
  rpc.mockReset();
});

describe("shared server-authoritative connection discovery", () => {
  it("polls once for two surfaces and removes a target when the server reports disconnect", async () => {
    vi.useFakeTimers();
    rpc.mockResolvedValueOnce([discovered]).mockResolvedValueOnce([]);
    const a = retainConnectedSshMonitorTargets();
    const b = retainConnectedSshMonitorTargets();
    await vi.waitFor(() =>
      expect(useConnectedSshMonitorStore.getState().targets[target]).toBe(true),
    );
    expect(rpc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(useConnectedSshMonitorStore.getState().targets).toEqual({});
    a();
    b();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("removes targets immediately when the transport disconnects and clears live data", async () => {
    vi.useFakeTimers();
    rpc.mockResolvedValueOnce([discovered]).mockRejectedValue(new WsTransportDisconnectedError());
    const release = retainConnectedSshMonitorTargets();
    await vi.waitFor(() =>
      expect(useConnectedSshMonitorStore.getState().targets[target]).toBe(true),
    );
    useRemoteMonitorStore.setState({
      [target]: {
        snapshot: { summaryStatus: "ready" } as NonNullable<
          NonNullable<ReturnType<typeof useRemoteMonitorStore.getState>[string]>["snapshot"]
        >,
        connection: "connected",
        reason: null,
        history: { cpu: [], memory: [], network: [] },
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(useConnectedSshMonitorStore.getState()).toMatchObject({
      targets: {},
      projects: [],
      status: "disconnected",
    });
    expect(useRemoteMonitorStore.getState()[target]).toMatchObject({
      snapshot: null,
      connection: "unavailable",
    });
    release();
    useRemoteMonitorStore.setState({}, true);
  });

  it("does not keep an inconclusive failure selectable or revoke saved verification", async () => {
    vi.useFakeTimers();
    const projects = useStore.getState().projects;
    const verifiedExecutionTargetIds = useRemoteAccessStore.getState().verifiedExecutionTargetIds;
    useStore.setState({
      projects: [
        {
          id: "saved-vps" as (typeof projects)[number]["id"],
          name: "Production",
          cwd: "/home/deploy",
          scripts: [],
          defaultModelSelection: null,
          workspaceExecutionTargetId: target,
        },
      ],
    });
    useRemoteAccessStore.getState().markExecutionTargetVerified(target);
    rpc.mockResolvedValueOnce([discovered]).mockRejectedValueOnce(new Error("discovery failed"));
    const release = retainConnectedSshMonitorTargets();
    try {
      await vi.waitFor(() => expect(useConnectedSshMonitorStore.getState().status).toBe("ready"));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(useConnectedSshMonitorStore.getState()).toMatchObject({
        targets: {},
        status: "unavailable",
      });
      expect(useRemoteAccessStore.getState().verifiedExecutionTargetIds[target]).toBe(true);
    } finally {
      release();
      useStore.setState({ projects });
      useRemoteAccessStore.setState({ verifiedExecutionTargetIds });
    }
  });

  it("clears sticky verification only after authoritative disconnection of a saved project", async () => {
    vi.useFakeTimers();
    const projects = useStore.getState().projects;
    const verifiedExecutionTargetIds = useRemoteAccessStore.getState().verifiedExecutionTargetIds;
    useStore.setState({
      projects: [
        {
          id: "saved-vps" as (typeof projects)[number]["id"],
          name: "Production",
          cwd: "/home/deploy",
          scripts: [],
          defaultModelSelection: null,
          workspaceExecutionTargetId: target,
        },
      ],
    });
    useRemoteAccessStore.getState().markExecutionTargetVerified(target);
    rpc
      .mockResolvedValueOnce([discovered])
      .mockRejectedValueOnce(new Error("discovery temporarily unavailable"))
      .mockResolvedValueOnce([]);
    const release = retainConnectedSshMonitorTargets();
    try {
      await vi.waitFor(() =>
        expect(useConnectedSshMonitorStore.getState().targets[target]).toBe(true),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(useRemoteAccessStore.getState().verifiedExecutionTargetIds[target]).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(useConnectedSshMonitorStore.getState().targets).toEqual({});
      expect(useRemoteAccessStore.getState().verifiedExecutionTargetIds[target]).toBeUndefined();
      expect(useRemoteAccessStore.getState().executionTargetChecks[target]?.status).toBe("idle");
    } finally {
      release();
      useStore.setState({ projects });
      useRemoteAccessStore.setState({ verifiedExecutionTargetIds });
    }
  });

  it("discovers a saved project even when its page has not been loaded in the client catalog", async () => {
    vi.useFakeTimers();
    const projects = useStore.getState().projects;
    useStore.setState({ projects: [] });
    rpc.mockResolvedValueOnce([discovered]).mockResolvedValueOnce([]);
    const release = retainConnectedSshMonitorTargets();
    try {
      await vi.waitFor(() =>
        expect(useConnectedSshMonitorStore.getState().projects).toEqual([discovered]),
      );
      expect(useStore.getState().projects).toEqual([]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(useConnectedSshMonitorStore.getState().projects).toEqual([]);
      expect(useConnectedSshMonitorStore.getState().status).toBe("ready");
    } finally {
      release();
      useStore.setState({ projects });
    }
  });

  it("revokes verification after authoritative removal even if discovery failed while the catalog was unloaded", async () => {
    vi.useFakeTimers();
    const projects = useStore.getState().projects;
    const verifiedExecutionTargetIds = useRemoteAccessStore.getState().verifiedExecutionTargetIds;
    useStore.setState({ projects: [] });
    useRemoteAccessStore.getState().markExecutionTargetVerified(target);
    rpc
      .mockResolvedValueOnce([discovered])
      .mockRejectedValueOnce(new WsTransportDisconnectedError())
      .mockResolvedValueOnce([]);
    const release = retainConnectedSshMonitorTargets();
    try {
      await vi.waitFor(() => expect(useConnectedSshMonitorStore.getState().status).toBe("ready"));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(useRemoteAccessStore.getState().verifiedExecutionTargetIds[target]).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(useConnectedSshMonitorStore.getState().projects).toEqual([]);
      expect(useRemoteAccessStore.getState().verifiedExecutionTargetIds[target]).toBeUndefined();
    } finally {
      release();
      useStore.setState({ projects });
      useRemoteAccessStore.setState({ verifiedExecutionTargetIds });
    }
  });

  it("does not invalidate verification during project creation before the project is saved", async () => {
    vi.useFakeTimers();
    const projects = useStore.getState().projects;
    const verifiedExecutionTargetIds = useRemoteAccessStore.getState().verifiedExecutionTargetIds;
    useStore.setState({ projects: [] });
    useRemoteAccessStore.getState().markExecutionTargetVerified(target);
    rpc.mockResolvedValueOnce([]);
    const release = retainConnectedSshMonitorTargets();
    try {
      await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
      expect(useRemoteAccessStore.getState().verifiedExecutionTargetIds[target]).toBe(true);
    } finally {
      release();
      useStore.setState({ projects });
      useRemoteAccessStore.setState({ verifiedExecutionTargetIds });
    }
  });
});
