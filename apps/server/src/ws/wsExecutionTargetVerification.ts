import {
  ServerUnlockSshKeyError,
  type ServerUnlockSshKeyInput,
  type ServerUnlockSshKeyResult,
  ServerUnlockSshPasswordError,
  type ServerUnlockSshPasswordInput,
  type ServerUnlockSshPasswordResult,
  ServerVerifyExecutionTargetError,
  type ServerVerifyExecutionTargetInput,
  type ServerVerifyExecutionTargetResult,
  ServerInstallRemoteAgentError,
  type ServerInstallRemoteAgentInput,
  type ServerInstallRemoteAgentResult,
} from "@bigbud/contracts";
import { Effect } from "effect";
import type {
  RemoteAgentHealth,
  RemoteAgentInstaller,
} from "../remote-agent/remoteAgentServerLayer.ts";

import {
  unlockSshExecutionTargetCredential,
  unlockSshExecutionTargetKey,
  verifySshExecutionTarget,
} from "../ssh/sshVerification.ts";

export const verifyExecutionTargetEffect = Effect.fn("verifyExecutionTargetEffect")(function* (
  input: ServerVerifyExecutionTargetInput,
  remoteAgentHealth?: RemoteAgentHealth,
): Effect.fn.Return<ServerVerifyExecutionTargetResult, ServerVerifyExecutionTargetError> {
  const sshResult = yield* Effect.tryPromise({
    try: () =>
      verifySshExecutionTarget({
        executionTargetId: input.executionTargetId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      }),
    catch: (cause) =>
      new ServerVerifyExecutionTargetError({
        message: cause instanceof Error ? cause.message : "Failed to verify SSH execution target.",
        cause,
      }),
  });
  if (!remoteAgentHealth) {
    return { ...sshResult, remoteAgent: { status: "disabled" } };
  }

  const agent = yield* Effect.tryPromise({
    try: () => remoteAgentHealth.verify(input.executionTargetId),
    catch: (cause) =>
      new ServerVerifyExecutionTargetError({
        message:
          cause instanceof Error
            ? `SSH access is available, but the configured remote agent is unavailable: ${cause.message}`
            : "SSH access is available, but the configured remote agent is unavailable.",
        cause,
      }),
  });
  if (agent.status === "install-required") {
    return {
      ...sshResult,
      message: `${sshResult.message} The bigbud remote agent must be installed before this remote project can be created.`,
      remoteAgent: { status: "install-required" },
    };
  }
  if (agent.status === "upgrade-required") {
    return {
      ...sshResult,
      message: `${sshResult.message} The bigbud remote agent must be upgraded from ${agent.currentVersion} to ${agent.targetVersion} before this remote project can be used.`,
      remoteAgent: {
        status: "upgrade-required",
        currentVersion: agent.currentVersion,
        targetVersion: agent.targetVersion,
      },
    };
  }
  return {
    ...sshResult,
    message: `${sshResult.message} Remote agent ${agent.agentVersion} is ready.`,
    remoteAgent: { status: "ready", version: agent.agentVersion },
  };
});

export const installRemoteAgentEffect = Effect.fn("installRemoteAgentEffect")(function* (
  input: ServerInstallRemoteAgentInput,
  remoteAgentInstaller?: RemoteAgentInstaller,
): Effect.fn.Return<ServerInstallRemoteAgentResult, ServerInstallRemoteAgentError> {
  if (!remoteAgentInstaller) {
    return yield* new ServerInstallRemoteAgentError({
      message: "Remote agent installation is disabled by the server configuration.",
    });
  }
  const result = yield* Effect.tryPromise({
    try: () => remoteAgentInstaller.install(input.executionTargetId),
    catch: (cause) =>
      new ServerInstallRemoteAgentError({
        message: cause instanceof Error ? cause.message : "Failed to install the remote agent.",
        cause,
      }),
  });
  return {
    executionTargetId: input.executionTargetId,
    version: result.version,
    message: `bigbud remote agent ${result.version} was installed successfully.`,
  };
});

export const unlockSshKeyEffect = Effect.fn("unlockSshKeyEffect")(function* (
  input: ServerUnlockSshKeyInput,
): Effect.fn.Return<ServerUnlockSshKeyResult, ServerUnlockSshKeyError> {
  return yield* Effect.tryPromise({
    try: () =>
      unlockSshExecutionTargetKey({
        executionTargetId: input.executionTargetId,
        passphrase: input.passphrase,
      }),
    catch: (cause) =>
      new ServerUnlockSshKeyError({
        message: cause instanceof Error ? cause.message : "Failed to unlock SSH key.",
        cause,
      }),
  });
});

export const unlockSshPasswordEffect = Effect.fn("unlockSshPasswordEffect")(function* (
  input: ServerUnlockSshPasswordInput,
): Effect.fn.Return<ServerUnlockSshPasswordResult, ServerUnlockSshPasswordError> {
  return yield* Effect.tryPromise({
    try: () =>
      unlockSshExecutionTargetCredential({
        executionTargetId: input.executionTargetId,
        secret: input.password,
      }),
    catch: (cause) =>
      new ServerUnlockSshPasswordError({
        message: cause instanceof Error ? cause.message : "Failed to unlock SSH password.",
        cause,
      }),
  });
});
