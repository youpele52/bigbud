import { composeBridgeCleanups } from "../../../orchestration-tools/orchestrationMcpBridge.session.ts";
import { describePiExit } from "./RpcProcess.errors.ts";
import { createPiRpcTransport } from "./RpcProcess.transport.ts";
import { startOwnedPiRpcProcess, type PiRpcOwnerBinding } from "./RpcProcess.owner.ts";
import type { PiRpcProcess, PiRpcProcessOptions } from "./RpcProcess.types.ts";

const emptyStderrTail = () => "";

/**
 * Starts remote Pi through the typed SSH owner lease. The consumer receives the owner's
 * pipes, exit and cancel handles; no local `ChildProcess` is fabricated and no SSH command
 * is built here.
 */
export async function startOwnedPiProcess(input: {
  readonly options: PiRpcProcessOptions;
  readonly binding: PiRpcOwnerBinding;
  /** Version already returned by the typed owner probe for this exact runtime. */
  readonly version: string;
}): Promise<PiRpcProcess> {
  const { options, binding } = input;
  const { owner, threadId, sessionEpoch } = binding;
  const lease = await startOwnedPiRpcProcess({
    owner,
    threadId,
    sessionEpoch,
    providerRuntimeTarget: options.providerRuntimeTarget,
    workspaceTarget: options.workspaceTarget,
    binaryPath: options.binaryPath,
    probedVersion: input.version,
    ...(options.sessionFile !== undefined ? { sessionFile: options.sessionFile } : {}),
  });

  const exitListeners = new Set<() => void>();
  let ended = false;
  const notifyExit = () => {
    if (ended) return;
    ended = true;
    for (const listener of exitListeners) listener();
    exitListeners.clear();
  };

  const cleanupBridge = composeBridgeCleanups(undefined, options.orchestrationBridge?.cleanup);
  let cleanedUp = false;
  const cleanupOnce = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    void cleanupBridge().catch(() => undefined);
  };

  let readStderrTail: () => string = emptyStderrTail;
  const transport = createPiRpcTransport({
    stdio: lease,
    cleanup: cleanupOnce,
    killOnOverflow: () => void lease.cancel().catch(() => undefined),
    describeExit: (code, signal) =>
      describePiExit({
        command: options.binaryPath,
        binaryPath: options.binaryPath,
        executionTargetId: binding.targetId,
        code,
        signal,
        stderrTail: readStderrTail(),
      }),
  });
  readStderrTail = transport.stderrTail;

  void lease.exit.then(
    (exit) => {
      if (exit.kind === "exited") transport.end(exit.code, null);
      else transport.end(null, exit.signal);
      notifyExit();
    },
    (error: unknown) => {
      transport.lifecycle.fail(error);
      notifyExit();
    },
  );

  const rpcArgs = [
    "--mode",
    "rpc",
    ...(options.sessionFile ? ["--session", options.sessionFile] : []),
  ];
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      try {
        await lease.cancel();
      } finally {
        cleanupOnce();
        notifyExit();
      }
    })());

  return {
    ...(lease.supportsAgentSettled !== undefined
      ? { supportsAgentSettled: lease.supportsAgentSettled }
      : {}),
    ...(lease.supportsPromptDisposition !== undefined
      ? { supportsPromptDisposition: lease.supportsPromptDisposition }
      : {}),
    command: options.binaryPath,
    args: rpcArgs,
    stderrTail: transport.stderrTail,
    request: transport.request,
    write: transport.write,
    subscribe: transport.subscribe,
    stop,
    isAlive: () => !ended,
    onExit: (listener) => {
      if (ended) {
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
