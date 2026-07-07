import { beforeEach, describe, expect, it } from "vitest";

import { isExecutionTargetVerified, useRemoteAccessStore } from "./remoteAccess.store";

describe("remoteAccessStore", () => {
  beforeEach(() => {
    useRemoteAccessStore.setState({
      verifiedExecutionTargetIds: {},
      executionTargetChecks: {},
      pendingAction: null,
      isAuthDialogOpen: false,
      authMode: null,
      authPromptLabel: "",
      authSecret: "",
      authError: null,
      isAuthenticating: false,
    });
  });

  it("tracks verified execution targets in memory only", () => {
    const executionTargetId = "ssh:host=devbox&user=root&port=22&auth=ssh-key";

    expect(isExecutionTargetVerified(executionTargetId)).toBe(false);

    useRemoteAccessStore.getState().markExecutionTargetVerified(executionTargetId);

    expect(isExecutionTargetVerified(executionTargetId)).toBe(true);

    useRemoteAccessStore.getState().clearExecutionTargetVerified(executionTargetId);

    expect(isExecutionTargetVerified(executionTargetId)).toBe(false);
    expect(useRemoteAccessStore.getState().executionTargetChecks[executionTargetId]?.status).toBe(
      "idle",
    );
  });

  it("tracks detailed remote execution check state per target", () => {
    const executionTargetId = "ssh:host=devbox&user=root&port=22&auth=ssh-key";

    useRemoteAccessStore.getState().setExecutionTargetCheck(executionTargetId, {
      status: "checking",
      message: "Checking remote access.",
      tip: "bigbud is still checking.",
      authMode: null,
      promptLabel: null,
    });

    expect(useRemoteAccessStore.getState().executionTargetChecks[executionTargetId]?.status).toBe(
      "checking",
    );

    useRemoteAccessStore.getState().setExecutionTargetCheck(executionTargetId, {
      status: "error",
      message: "Remote host is unreachable.",
      tip: "Reconnect to the network and try again.",
      authMode: null,
      promptLabel: null,
    });

    expect(isExecutionTargetVerified(executionTargetId)).toBe(false);
    expect(useRemoteAccessStore.getState().executionTargetChecks[executionTargetId]?.status).toBe(
      "error",
    );
  });

  it("opens and resets the shared auth dialog state", () => {
    const executionTargetId = "ssh:host=devbox&user=root&port=22&auth=ssh-key";

    useRemoteAccessStore.getState().openAuthDialog({
      pendingAction: {
        executionTargetId,
        onVerified: () => undefined,
      },
      authMode: "password",
      promptLabel: "root@devbox:22",
    });

    expect(useRemoteAccessStore.getState().isAuthDialogOpen).toBe(true);
    expect(useRemoteAccessStore.getState().authMode).toBe("password");
    expect(useRemoteAccessStore.getState().authPromptLabel).toBe("root@devbox:22");

    useRemoteAccessStore.getState().closeAuthDialog();

    expect(useRemoteAccessStore.getState().isAuthDialogOpen).toBe(false);
    expect(useRemoteAccessStore.getState().pendingAction).toBeNull();
    expect(useRemoteAccessStore.getState().authPromptLabel).toBe("");
  });
});
