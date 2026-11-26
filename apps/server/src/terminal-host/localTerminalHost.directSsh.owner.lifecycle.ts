import type { RemoteAgentOwner } from "../remote-agent/remoteAgentOwners.ts";
import type { OwnedPtyLocalSshClient } from "../terminal/Services/OwnedPtyRuntime.ts";
import { NativeSshPtyHostLostError, type PtyProcess } from "../terminal/Services/PTY.ts";
import type { NativeDirectSshTerminalOptions } from "./localTerminalHost.directSsh.owner.ts";
import type {
  NativeDirectSshTerminalAttachment,
  NativeDirectSshTerminalBinding,
} from "./localTerminalHost.directSsh.owner.port.ts";

export const NATIVE_SSH_CONNECTION_PREFIX = "ssh-owner:";
const CLOSE_TIMEOUT_MS = 15_000;

export function nativeDirectSshBinding(route: RemoteAgentOwner): NativeDirectSshTerminalBinding {
  if (!route.connectionId.startsWith(NATIVE_SSH_CONNECTION_PREFIX) || route.shellLaunch)
    throw new Error("The retained pane does not belong to the native SSH owner.");
  return {
    targetId: route.target,
    ownerEpoch: route.epoch,
    targetGeneration: route.connectionId.slice(NATIVE_SSH_CONNECTION_PREFIX.length),
    leaseId: route.resourceId,
  };
}

const sameBinding = (left: NativeDirectSshTerminalBinding, right: NativeDirectSshTerminalBinding) =>
  left.targetId === right.targetId &&
  left.ownerEpoch === right.ownerEpoch &&
  left.targetGeneration === right.targetGeneration &&
  left.leaseId === right.leaseId;

const sameRoute = (left: RemoteAgentOwner, right: RemoteAgentOwner) =>
  left.ownerKey === right.ownerKey &&
  left.target === right.target &&
  left.epoch === right.epoch &&
  left.connectionId === right.connectionId &&
  left.resourceId === right.resourceId &&
  left.reservationId === right.reservationId &&
  !left.shellLaunch &&
  !right.shellLaunch;

export function isNativeDirectSshHostLost(route: RemoteAgentOwner): boolean {
  return (
    route.connectionId.startsWith(NATIVE_SSH_CONNECTION_PREFIX) &&
    !route.shellLaunch &&
    route.state === "outcome-unknown"
  );
}

/** Only a possibly dispatched exact lease can be marked lost; never overwrite a newer or closed row. */
async function recordNativeHostLoss(
  options: NativeDirectSshTerminalOptions,
  route: RemoteAgentOwner,
) {
  const saved = await options
    .owners()
    .update(
      route.ownerKey,
      (candidate) =>
        sameRoute(candidate, route) && candidate.state === "may-have-been-sent"
          ? { ...candidate, state: "outcome-unknown" }
          : candidate,
      route.target,
    );
  return sameRoute(saved, route) && isNativeDirectSshHostLost(saved);
}

export async function observeNativeHostFailure(
  options: NativeDirectSshTerminalOptions,
  route: RemoteAgentOwner,
  cause: unknown,
): Promise<unknown> {
  if (!(cause instanceof NativeSshPtyHostLostError)) return cause;
  if (await recordNativeHostLoss(options, route).catch(() => false)) return cause;
  return new Error(
    "sshOwnerUnavailable: The native SSH terminal could not be confirmed; no replacement was started.",
  );
}

export function makeNativeDirectSshLifecycle(
  options: NativeDirectSshTerminalOptions,
  isClosed: () => boolean,
  isDirect: (target: string) => boolean,
): OwnedPtyLocalSshClient {
  const inspect = async (
    route: RemoteAgentOwner,
    operation: "status" | "close",
    callerSignal?: AbortSignal,
  ) => {
    const timeout = AbortSignal.timeout(CLOSE_TIMEOUT_MS);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    signal.throwIfAborted();
    const binding = nativeDirectSshBinding(route);
    if (!isDirect(binding.targetId) || route.state === "prepared") return "unknown";
    const store = options.owners();
    const current = await store.get(route.ownerKey);
    if (!current || !sameRoute(current, route)) return "unknown";
    if (current.state === "terminal") return "gone";
    if (isClosed() || isNativeDirectSshHostLost(current)) return "unknown";
    signal.throwIfAborted();
    const receipt = await options.port[operation](binding, signal).catch(async (cause: unknown) => {
      throw await observeNativeHostFailure(options, route, cause);
    });
    signal.throwIfAborted();
    if (!sameBinding(binding, receipt.binding)) return "unknown";
    if (receipt.state === "live") return "live";
    if (receipt.state !== "exited") return "unknown";
    const saved = await store.update(
      route.ownerKey,
      (candidate) =>
        sameRoute(candidate, route) ? { ...candidate, state: "terminal" } : candidate,
      route.target,
    );
    return sameRoute(saved, route) && saved.state === "terminal" ? "gone" : "unknown";
  };
  return {
    isHostLost: isNativeDirectSshHostLost,
    status: (route, signal) => inspect(route, "status", signal).catch(() => "unknown"),
    close: async (route, signal) => {
      if ((await inspect(route, "close", signal).catch(() => "unknown")) !== "gone")
        throw new Error(
          "The native SSH owner could not confirm termination; the pane stays reserved.",
        );
    },
  };
}

export function bindNativeDirectSshProcess(
  options: NativeDirectSshTerminalOptions,
  lifecycle: OwnedPtyLocalSshClient,
  route: RemoteAgentOwner,
  attachment: NativeDirectSshTerminalAttachment,
  recovered: boolean,
  assertAvailable: () => void,
): PtyProcess {
  const { process } = attachment;
  try {
    assertAvailable();
    if (!sameBinding(nativeDirectSshBinding(route), attachment.binding))
      throw new Error("The native SSH terminal attachment does not match the reserved lease.");
  } catch (cause) {
    process.detach();
    throw cause;
  }
  let exit: Promise<void> | undefined;
  let unverifiedExit = false;
  return {
    pidDomain: "remote",
    recovered,
    ...(recovered && attachment.recoveredHistoryFromStart
      ? { recoveredHistoryFromStart: true }
      : {}),
    remoteResourceId: route.resourceId,
    prepareRestart: () => lifecycle.close(route),
    get pid() {
      return process.pid;
    },
    get interruptionReason() {
      return (
        process.interruptionReason ??
        (unverifiedExit ? "ssh-owner-termination-unconfirmed" : undefined)
      );
    },
    detach: () => process.detach(),
    write: (data) => process.write(data),
    resize: (cols, rows) => process.resize(cols, rows),
    kill: (signal) => process.kill(signal),
    onData: (callback) => process.onData(callback),
    onExit: (callback) => {
      let active = true;
      const stop = process.onExit((event) => {
        exit ??= lifecycle.status(route).then((status) => {
          unverifiedExit = status !== "gone";
        });
        void exit.then(() => {
          if (active) callback(event);
        });
      });
      return () => {
        active = false;
        stop();
      };
    },
    ...(process.pause ? { pause: process.pause.bind(process) } : {}),
    ...(process.resume ? { resume: process.resume.bind(process) } : {}),
    onError: (callback) => {
      let active = true;
      const stop = process.onError?.((error) => {
        if (!(error instanceof NativeSshPtyHostLostError)) {
          callback(error);
          return;
        }
        void observeNativeHostFailure(options, route, error).then((failure) => {
          if (active && failure instanceof Error) callback(failure);
        });
      });
      return () => {
        active = false;
        stop?.();
      };
    },
    ...(process.onSequencedData ? { onSequencedData: process.onSequencedData.bind(process) } : {}),
    ...(process.reconnectRemote ? { reconnectRemote: process.reconnectRemote.bind(process) } : {}),
    ...(process.detachRemote ? { detachRemote: process.detachRemote.bind(process) } : {}),
    ...(process.screen ? { screen: process.screen } : {}),
    ...(process.lifecycle ? { lifecycle: process.lifecycle } : {}),
  };
}
