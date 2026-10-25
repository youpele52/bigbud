import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRemoteAccessStore } from "../stores/remoteAccess/remoteAccess.store";
import { submitRemoteExecutionAuth } from "./useRemoteExecutionAccessGate.auth";

const api = vi.hoisted(() => ({
  server: {
    trustSshHost: vi.fn(),
    unlockSshPassword: vi.fn(),
    unlockSshKey: vi.fn(),
    verifyExecutionTarget: vi.fn(),
  },
}));
vi.mock("../rpc/nativeApi", () => ({ readNativeApi: () => api }));
vi.mock("./useRemoteExecutionAccessGate.checks", () => ({
  showRemoteExecutionFailureToast: vi.fn(),
}));

const target = "ssh:host=box&auth=password";
const challenge = {
  challengeId: "approval-1",
  host: "box",
  keyType: "ED25519",
  fingerprint: "SHA256:abc123",
};
const trustMessage = `SSH host trust is required: ${JSON.stringify(challenge)}`;
const onVerified = vi.fn();

describe("remote access authentication continuation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useRemoteAccessStore.getState().clearAuthDialog();
    useRemoteAccessStore.setState({ verifiedExecutionTargetIds: {}, executionTargetChecks: {} });
    useRemoteAccessStore.getState().openAuthDialog({
      pendingAction: { executionTargetId: target, cwd: "/srv/app", onVerified },
      authMode: "host-trust",
      promptLabel: trustMessage,
    });
  });

  it("keeps the pending action while switching from host trust to password, then resumes once", async () => {
    api.server.verifyExecutionTarget.mockRejectedValueOnce(
      new Error("SSH password is required for box. Re-enter it before using this target."),
    );
    await submitRemoteExecutionAuth(vi.fn());
    expect(api.server.trustSshHost).toHaveBeenCalledWith({
      executionTargetId: target,
      challengeId: "approval-1",
    });
    expect(api.server.unlockSshPassword).not.toHaveBeenCalled();
    expect(onVerified).not.toHaveBeenCalled();
    expect(useRemoteAccessStore.getState()).toMatchObject({
      isAuthDialogOpen: true,
      authMode: "password",
      authSecret: "",
      authError: null,
      isAuthenticating: false,
    });
    useRemoteAccessStore.getState().setAuthSecret("secret");
    api.server.verifyExecutionTarget.mockResolvedValue({ remoteAgent: { status: "disabled" } });
    await submitRemoteExecutionAuth(vi.fn());
    expect(api.server.unlockSshPassword).toHaveBeenCalledWith({
      executionTargetId: target,
      password: "secret",
    });
    expect(onVerified).toHaveBeenCalledOnce();
    expect(useRemoteAccessStore.getState().isAuthDialogOpen).toBe(false);
    expect(useRemoteAccessStore.getState().verifiedExecutionTargetIds[target]).toBe(true);
  });

  it("retains an actionable newly presented fingerprint rather than reusing prior approval", async () => {
    const changed = `SSH host trust is required: ${JSON.stringify({ ...challenge, challengeId: "approval-2", fingerprint: "SHA256:new" })}`;
    api.server.trustSshHost.mockRejectedValueOnce(new Error(changed));
    await submitRemoteExecutionAuth(vi.fn());
    expect(useRemoteAccessStore.getState()).toMatchObject({
      authMode: "host-trust",
      authPromptLabel: changed,
      authSecret: "",
      isAuthDialogOpen: true,
    });
    expect(onVerified).not.toHaveBeenCalled();
  });

  it("blocks changed known keys without continuing the action", async () => {
    api.server.trustSshHost.mockRejectedValueOnce(
      new Error("The SSH server's identity has changed. Connection blocked."),
    );
    await submitRemoteExecutionAuth(vi.fn());
    expect(onVerified).not.toHaveBeenCalled();
    expect(useRemoteAccessStore.getState().isAuthDialogOpen).toBe(false);
    expect(useRemoteAccessStore.getState().executionTargetChecks[target]?.status).toBe("error");
  });

  it("does not submit credentials or trust anything after cancellation", async () => {
    useRemoteAccessStore.getState().closeAuthDialog();
    await submitRemoteExecutionAuth(vi.fn());
    expect(api.server.trustSshHost).not.toHaveBeenCalled();
    expect(api.server.unlockSshPassword).not.toHaveBeenCalled();
    expect(onVerified).not.toHaveBeenCalled();
  });
});
