import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRemoteAccessStore } from "../stores/remoteAccess/remoteAccess.store";
import {
  type RemoteExecutionAccessGate,
  useRemoteExecutionAccessGate,
} from "./useRemoteExecutionAccessGate";

const api = vi.hoisted(() => ({
  server: { verifyExecutionTarget: vi.fn(), connectExecutionTarget: vi.fn() },
}));
const toast = vi.hoisted(() => ({ add: vi.fn(), close: vi.fn(), update: vi.fn() }));
vi.mock("../rpc/nativeApi", () => ({ readNativeApi: () => api }));
vi.mock("../components/ui/toast", () => ({ toastManager: toast }));

const target = "ssh:host=devbox&user=root&port=22&auth=ssh-key";

function renderGate(): RemoteExecutionAccessGate {
  let gate: RemoteExecutionAccessGate | null = null;
  function Probe() {
    gate = useRemoteExecutionAccessGate();
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return gate!;
}

describe("remote execution access gate for a user-disconnected target", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    toast.add.mockReturnValue("toast-id");
    useRemoteAccessStore.setState({
      verifiedExecutionTargetIds: {},
      disconnectedExecutionTargetIds: { [target]: true },
      disconnectedTargetsLoaded: true,
      executionTargetChecks: {},
    });
  });

  it("begin proceeds for navigation without verifying or toasting", async () => {
    const onVerified = vi.fn();

    await expect(
      renderGate().beginRemoteExecutionTargetAccessCheck({
        executionTargetId: target,
        cwd: "/srv/app",
        onVerified,
      }),
    ).resolves.toBe(true);

    expect(onVerified).toHaveBeenCalledOnce();
    expect(api.server.verifyExecutionTarget).not.toHaveBeenCalled();
    expect(toast.add).not.toHaveBeenCalled();
  });

  it("begin returns proceed without resuming when the caller continues itself", async () => {
    const onVerified = vi.fn();

    await expect(
      renderGate().beginRemoteExecutionTargetAccessCheck({
        executionTargetId: target,
        onVerified,
        resumeOnUnlockOnly: true,
      }),
    ).resolves.toBe(true);
    expect(onVerified).not.toHaveBeenCalled();
    expect(api.server.verifyExecutionTarget).not.toHaveBeenCalled();
  });

  it("ensure blocks with a Connect action that clears the flag and then really verifies", async () => {
    vi.stubGlobal("window", globalThis);
    // A verify that finished after Disconnect left a stale verified mark; Connect must ignore it.
    useRemoteAccessStore.setState({ verifiedExecutionTargetIds: { [target]: true } });
    api.server.connectExecutionTarget.mockResolvedValue({
      executionTargetId: target,
      disconnected: false,
    });
    api.server.verifyExecutionTarget.mockResolvedValue({});
    const onVerified = vi.fn();

    await expect(
      renderGate().ensureRemoteExecutionTargetAccess({
        executionTargetId: target,
        cwd: "/srv/app",
        onVerified,
        resumeOnUnlockOnly: true,
      }),
    ).resolves.toBe(false);
    expect(api.server.verifyExecutionTarget).not.toHaveBeenCalled();
    expect(onVerified).not.toHaveBeenCalled();
    const blocked = toast.add.mock.calls.at(-1)?.[0];
    expect(blocked).toMatchObject({
      type: "warning",
      title: "root@devbox is disconnected",
      actionProps: { children: "Connect" },
    });

    blocked.actionProps.onClick();

    await vi.waitFor(() => expect(onVerified).toHaveBeenCalledOnce());
    expect(api.server.connectExecutionTarget).toHaveBeenCalledWith({ executionTargetId: target });
    expect(api.server.verifyExecutionTarget).toHaveBeenCalledWith({
      executionTargetId: target,
      cwd: "/srv/app",
    });
    expect(useRemoteAccessStore.getState().disconnectedExecutionTargetIds[target]).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("waits for the disconnect list before any background verification", async () => {
    useRemoteAccessStore.setState({
      disconnectedExecutionTargetIds: {},
      disconnectedTargetsLoaded: false,
    });
    const gate = renderGate();
    const onVerified = vi.fn();

    await expect(
      gate.beginRemoteExecutionTargetAccessCheck({ executionTargetId: target, onVerified }),
    ).resolves.toBe(true);
    await expect(
      gate.ensureRemoteExecutionTargetAccess({ executionTargetId: target, onVerified }),
    ).resolves.toBe(true);

    expect(onVerified).toHaveBeenCalledTimes(2);
    expect(api.server.verifyExecutionTarget).not.toHaveBeenCalled();
    expect(useRemoteAccessStore.getState().executionTargetChecks[target]).toBeUndefined();
    expect(toast.add).not.toHaveBeenCalled();
  });

  it("still proceeds for local targets", async () => {
    const onVerified = vi.fn();

    await expect(
      renderGate().ensureRemoteExecutionTargetAccess({ executionTargetId: "local", onVerified }),
    ).resolves.toBe(true);
    expect(onVerified).toHaveBeenCalledOnce();
    expect(toast.add).not.toHaveBeenCalled();
  });
});
