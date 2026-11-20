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
import type { RemoteAgentUpdateCoordinatorShape } from "../remote-agent/remoteAgentUpdate.coordinator.ts";

import {
  unlockSshExecutionTargetCredential,
  unlockSshExecutionTargetKey,
  verifySshExecutionTarget,
} from "../ssh/sshVerification.ts";
import { isRemoteAgentExecutionTarget } from "../remote-agent/remoteAgentDefault.ts";
import { remoteAgentFailureMessage } from "../remote-agent/remoteAgentFailure.ts";
import type {
  RemoteAgentInstallOperations,
  RemoteAgentStagedBuild,
} from "../remote-agent/remoteAgentInstall.operation.ts";
import type {
  ServerGetRemoteAgentManualInstallInput,
  ServerGetRemoteAgentManualInstallResult,
} from "@bigbud/contracts/server/server.remoteAgentInstall";

export const verifyExecutionTargetEffect = Effect.fn("verifyExecutionTargetEffect")(function* (
  input: ServerVerifyExecutionTargetInput,
  remoteAgentHealth?: RemoteAgentHealth,
  remoteAgentUpdateCoordinator?: RemoteAgentUpdateCoordinatorShape,
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
  const usesRemoteAgent = isRemoteAgentExecutionTarget(input.executionTargetId);
  if (usesRemoteAgent) {
    remoteAgentUpdateCoordinator?.enqueue({
      target: input.executionTargetId,
      trigger: "authenticated",
      authenticated: true,
    });
  }
  if (!usesRemoteAgent || !remoteAgentHealth) {
    return { ...sshResult, remoteAgent: { status: "disabled" } };
  }

  const agent = yield* Effect.tryPromise({
    try: (signal) => remoteAgentHealth.verify(input.executionTargetId, signal),
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
      message: `${sshResult.message} The bigbud remote agent must be installed before this remote workspace can be created.`,
      remoteAgent: { status: "install-required" },
    };
  }
  if (agent.status === "upgrade-required") {
    return {
      ...sshResult,
      message: `${sshResult.message} The bigbud remote agent must be upgraded from ${agent.currentVersion} to ${agent.targetVersion} before this remote workspace can be used.`,
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
    remoteAgent: {
      status: "ready",
      version: agent.agentVersion,
      ...(agent.runtimeSummary ? { runtimeSummary: agent.runtimeSummary } : {}),
    },
  };
});

/**
 * The app's Install shares the CLI/agent-tool operation registry: staging is serialized per target
 * and joins an operation already running there. Activation stays behind the app's explicit
 * Finish step, which uses the same fresh-admission core (D6).
 */
type SharedInstallResult = Omit<RemoteAgentStagedBuild, "version"> & {
  readonly version?: string;
  readonly active?: boolean;
  readonly outcome?:
    | import("../remote-agent/remoteAgentInstall.operation.ts").RemoteAgentOperationOutcome
    | null;
  readonly cleanupDeferred?: boolean;
  readonly operationMessage?: string;
};

async function stageThroughSharedOperation(
  operations: RemoteAgentInstallOperations,
  executionTargetId: string,
  signal: AbortSignal,
  replace = false,
): Promise<SharedInstallResult> {
  const started = operations.start({ executionTargetId, replace, stageOnly: !replace });
  if (replace && started.kind !== "replace")
    throw new Error("Another install is running. Wait for it to complete before replacing.");
  let snapshot = operations.get(started.operationId) ?? started;
  while (snapshot.state !== "completed") {
    if (signal.aborted) throw new Error("Remote agent staging was cancelled.");
    const next = await operations.wait(started.operationId, 5_000);
    if (!next) throw new Error("The remote agent operation is no longer available.");
    snapshot = next;
  }
  // A version is recorded only after staging succeeded. A joined CLI install that later
  // deferred or failed at activation still staged the bytes, which is all the app asked for.
  if (snapshot.version || replace) {
    return {
      ...operations.stagedBuild(started.operationId),
      ...(snapshot.version ? { version: snapshot.version } : {}),
      active: snapshot.outcome === "active",
      outcome: snapshot.outcome,
      cleanupDeferred: snapshot.cleanupDeferred,
      operationMessage: snapshot.message,
    };
  }
  throw new Error(snapshot.message);
}

export const installRemoteAgentEffect = Effect.fn("installRemoteAgentEffect")(function* (
  input: ServerInstallRemoteAgentInput,
  context: {
    readonly remoteAgentInstaller?: RemoteAgentInstaller | undefined;
    readonly remoteAgentInstallOperations?: RemoteAgentInstallOperations | undefined;
  },
): Effect.fn.Return<ServerInstallRemoteAgentResult, ServerInstallRemoteAgentError> {
  const remoteAgentInstaller = context.remoteAgentInstaller;
  const operations = context.remoteAgentInstallOperations;
  if (!isRemoteAgentExecutionTarget(input.executionTargetId)) {
    return yield* new ServerInstallRemoteAgentError({
      message:
        "This remote workspace uses Direct SSH. No bigbud remote agent installation is required.",
    });
  }
  if (!remoteAgentInstaller) {
    return yield* new ServerInstallRemoteAgentError({
      message: "Remote agent installation is disabled by the server configuration.",
    });
  }
  if (input.replace && !operations)
    return yield* new ServerInstallRemoteAgentError({
      message: "Shared replacement operations are unavailable.",
    });
  const result = yield* Effect.tryPromise({
    try: async (signal): Promise<SharedInstallResult> =>
      operations
        ? stageThroughSharedOperation(operations, input.executionTargetId, signal, input.replace)
        : remoteAgentInstaller.install(input.executionTargetId, signal),
    catch: (cause) =>
      new ServerInstallRemoteAgentError({
        message: remoteAgentFailureMessage(cause),
        cause,
      }),
  });
  const source =
    result.placement === "inbox"
      ? " from the agent you placed on the remote host"
      : result.placement === "managed"
        ? " from the build already on the remote host"
        : "";
  const conflict = result.inboxConflict
    ? " A different file in ~/.bigbud/agent/inbox did not match the signed release and was left untouched."
    : "";
  return {
    executionTargetId: input.executionTargetId,
    version: result.version,
    ...(input.replace && result.outcome
      ? { outcome: result.outcome, cleanupDeferred: result.cleanupDeferred }
      : {}),
    message:
      input.replace && result.operationMessage
        ? result.operationMessage
        : result.active
          ? `Remote agent ${result.version} is already active.${conflict}`
          : `Update ${result.version} staged${source}. It will be used on your next new connection.${conflict}`,
    ...(result.runtimeSummary ? { runtimeSummary: result.runtimeSummary } : {}),
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

export const getRemoteAgentManualInstallEffect = Effect.fn("getRemoteAgentManualInstallEffect")(
  function* (
    input: ServerGetRemoteAgentManualInstallInput,
    remoteAgentInstaller?: RemoteAgentInstaller,
  ): Effect.fn.Return<ServerGetRemoteAgentManualInstallResult, ServerInstallRemoteAgentError> {
    const manualInstall = remoteAgentInstaller?.manualInstall;
    if (!isRemoteAgentExecutionTarget(input.executionTargetId) || !manualInstall) {
      return yield* new ServerInstallRemoteAgentError({
        message: "Manual remote agent installation is unavailable for this workspace.",
      });
    }
    return yield* Effect.tryPromise({
      try: (signal) => manualInstall(input.executionTargetId, signal),
      catch: (cause) =>
        new ServerInstallRemoteAgentError({ message: remoteAgentFailureMessage(cause), cause }),
    });
  },
);
