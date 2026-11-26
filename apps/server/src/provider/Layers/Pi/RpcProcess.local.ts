import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { isLocalProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import { composeBridgeCleanups } from "../../../orchestration-tools/orchestrationMcpBridge.session.ts";
import { buildSshCommandInvocation } from "../../../ssh/sshCommand.ts";
import {
  isLocalWorkspaceTarget,
  isRemoteWorkspaceTarget,
} from "../../../workspace-target/workspaceTarget.ts";
import { killProcessTree } from "../../../utils/killProcessTree.ts";
import {
  buildPiRpcInvocation,
  quoteWindowsPiShellCommand,
  shouldUseWindowsPiShell,
} from "./Cli.ts";
import {
  createPiRemoteWorkspaceBridge,
  type PiRemoteWorkspaceExtensionBridge,
} from "./PiRemoteWorkspaceBridge.ts";
import { describePiExit } from "./RpcProcess.errors.ts";
import { createPiRpcTransport } from "./RpcProcess.transport.ts";
import type { PiRpcProcess, PiRpcProcessOptions } from "./RpcProcess.types.ts";
import type { piVersionCapabilities } from "./RpcProcess.version.ts";

const emptyStderrTail = () => "";

async function preparePiRpcProcessBridge(
  options: PiRpcProcessOptions,
): Promise<PiRemoteWorkspaceExtensionBridge | undefined> {
  if (
    !isLocalProviderRuntimeTarget(options.providerRuntimeTarget) ||
    !isRemoteWorkspaceTarget(options.workspaceTarget)
  ) {
    return undefined;
  }

  return createPiRemoteWorkspaceBridge(
    options.workspaceTarget,
    options.orchestrationBridge?.httpConfig,
    options.remoteWorkspaceReadinessProbe,
  );
}

/**
 * Legacy or local Pi launch. A selected dev owner never reaches this module: the dispatcher
 * refuses before any bridge or child exists.
 */
export async function startLocalPiRpcProcess(input: {
  readonly options: PiRpcProcessOptions;
  readonly executionTargetId: string;
  readonly capabilities: ReturnType<typeof piVersionCapabilities>;
}): Promise<PiRpcProcess> {
  const { options, executionTargetId, capabilities } = input;
  const bridge = await preparePiRpcProcessBridge(options);
  const rpcArgs = [
    ...(options.sessionFile ? ["--session", options.sessionFile] : []),
    ...(bridge ? bridge.extraArgs : []),
    ...(options.orchestrationBridge ? options.orchestrationBridge.extraArgs : []),
  ];
  const invocation = isLocalProviderRuntimeTarget(options.providerRuntimeTarget)
    ? buildPiRpcInvocation(options.binaryPath, rpcArgs)
    : buildSshCommandInvocation({
        executionTargetId,
        command: options.binaryPath,
        args: ["--mode", "rpc", ...(options.sessionFile ? ["--session", options.sessionFile] : [])],
        ...(options.workspaceTarget.cwd ? { cwd: options.workspaceTarget.cwd } : {}),
      });
  const localSpawnCwd =
    bridge?.cwd ??
    (isLocalProviderRuntimeTarget(options.providerRuntimeTarget) &&
    isLocalWorkspaceTarget(options.workspaceTarget)
      ? options.workspaceTarget.cwd
      : undefined);

  let child: ChildProcessWithoutNullStreams;
  const useWindowsShell =
    isLocalProviderRuntimeTarget(options.providerRuntimeTarget) &&
    shouldUseWindowsPiShell(invocation.command);
  const command = useWindowsShell
    ? quoteWindowsPiShellCommand(invocation.command)
    : invocation.command;
  try {
    child = spawn(command, invocation.args, {
      ...(localSpawnCwd ? { cwd: localSpawnCwd } : {}),
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: useWindowsShell,
    });
  } catch (error) {
    void composeBridgeCleanups(bridge?.cleanup, options.orchestrationBridge?.cleanup)().catch(
      () => undefined,
    );
    throw error;
  }

  const cleanupBridge = composeBridgeCleanups(
    bridge?.cleanup,
    options.orchestrationBridge?.cleanup,
  );
  let cleanedUp = false;
  const cleanupBridgeOnce = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    void cleanupBridge().catch(() => undefined);
  };

  const exitListeners = new Set<() => void>();
  const notifyExit = () => {
    for (const listener of exitListeners) listener();
    exitListeners.clear();
  };
  child.once("exit", notifyExit);
  child.once("close", notifyExit);

  let readStderrTail: () => string = emptyStderrTail;
  const transport = createPiRpcTransport({
    stdio: child,
    cleanup: cleanupBridgeOnce,
    killOnOverflow: () => killProcessTree(child, "SIGKILL"),
    describeExit: (code, signal) =>
      describePiExit({
        command: invocation.command,
        binaryPath: options.binaryPath,
        executionTargetId,
        code,
        signal,
        stderrTail: readStderrTail(),
      }),
  });
  readStderrTail = transport.stderrTail;
  child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    transport.end(code, signal);
  });
  child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
    transport.end(code, signal);
  });

  let exitPromise: Promise<void> | undefined;
  const killPiChild = (signal: NodeJS.Signals) => killProcessTree(child, signal);
  const stop = async () => {
    if (exitPromise) {
      return exitPromise;
    }

    exitPromise = new Promise<void>((resolve) => {
      if (transport.lifecycle.processEnded() || child.exitCode !== null) {
        cleanupBridgeOnce();
        resolve();
        return;
      }

      const settleStop = () => {
        cleanupBridgeOnce();
        resolve();
      };
      child.once("exit", settleStop);
      child.once("close", settleStop);

      const sigkillTimer = setTimeout(() => {
        if (child.exitCode === null) {
          killPiChild("SIGKILL");
        }
      }, 1_000);
      child.once("exit", () => clearTimeout(sigkillTimer));
      child.once("close", () => clearTimeout(sigkillTimer));

      killPiChild("SIGTERM");
    });

    return exitPromise;
  };

  return {
    child,
    ...capabilities,
    command: invocation.command,
    args: invocation.args,
    ...(localSpawnCwd ? { cwd: localSpawnCwd } : {}),
    stderrTail: transport.stderrTail,
    request: transport.request,
    write: transport.write,
    subscribe: transport.subscribe,
    stop,
    isAlive: () => (child.exitCode ?? null) === null && (child.signalCode ?? null) === null,
    onExit: (listener) => {
      if ((child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null) {
        listener();
        return () => undefined;
      }
      exitListeners.add(listener);
      return () => {
        exitListeners.delete(listener);
      };
    },
  };
}
