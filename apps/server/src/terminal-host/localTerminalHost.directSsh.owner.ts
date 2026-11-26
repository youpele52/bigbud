import { randomUUID } from "node:crypto";
import { Effect } from "effect";

import { RemoteAgentConnectionPool } from "../remote-agent/remoteAgentConnectionPool.ts";
import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import { remoteAgentPtyRequestDigest } from "../remote-agent/remoteAgentShellLaunch.ts";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import type { OwnedPtyRuntime } from "../terminal/Services/OwnedPtyRuntime.ts";
import {
  NativeSshPtyHostLostError,
  PtySpawnError,
  type PtyAdapterShape,
  type PtySpawnInput,
} from "../terminal/Services/PTY.ts";
import {
  bindNativeDirectSshProcess,
  makeNativeDirectSshLifecycle,
  isNativeDirectSshHostLost,
  nativeDirectSshBinding,
  NATIVE_SSH_CONNECTION_PREFIX,
  observeNativeHostFailure,
} from "./localTerminalHost.directSsh.owner.lifecycle.ts";
import type {
  NativeDirectSshTerminalOpen,
  NativeDirectSshTerminalOwner,
} from "./localTerminalHost.directSsh.owner.port.ts";

export interface NativeDirectSshTerminalOptions {
  readonly port: NativeDirectSshTerminalOwner;
  /**
   * U16 (production): the owner-listed shell path for a selected profile, or
   * `undefined` to refuse the profile. Absent: every shell profile is refused.
   */
  readonly shellFor?: (input: PtySpawnInput) => string | undefined;
  /** The shared terminal owner store, before narrowing it to the legacy local-host target. */
  readonly owners: () => RemoteAgentOwnerStore;
  /** Verified native build metadata in the existing local host's durable runtime format. */
  readonly runtime: RemoteAgentRuntime;
}

class NativeTerminalPolicyError extends Error {}

const identity = (value: string, max = 256) =>
  value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value);

function paneOf(ownerKey: string | undefined) {
  const value: unknown = ownerKey === undefined ? null : JSON.parse(ownerKey);
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    JSON.stringify(value) !== ownerKey ||
    typeof value[0] !== "string" ||
    !value[0] ||
    typeof value[1] !== "string" ||
    !value[1] ||
    !identity(`terminal:${ownerKey}`)
  )
    throw new NativeTerminalPolicyError(
      "An authorized pane identity is required for a native SSH terminal.",
    );
  return { threadId: value[0], terminalId: value[1] };
}

function openRequest(
  input: PtySpawnInput,
  targetId: string,
  pane: NativeDirectSshTerminalOpen["pane"],
  shellFor?: (input: PtySpawnInput) => string | undefined,
): NativeDirectSshTerminalOpen {
  const cwd = input.remoteCwd;
  if (!cwd?.startsWith("/") || cwd.includes("\0") || Buffer.byteLength(cwd) > 4096)
    throw new NativeTerminalPolicyError(
      "An authorized absolute remote directory is required for a native SSH terminal.",
    );
  if (
    !Number.isInteger(input.cols) ||
    input.cols < 1 ||
    input.cols > 1000 ||
    !Number.isInteger(input.rows) ||
    input.rows < 1 ||
    input.rows > 500
  )
    throw new NativeTerminalPolicyError(
      "The native SSH terminal size is outside the product limits.",
    );
  const shell = input.shellProfile ? shellFor?.(input) : undefined;
  if (input.shellLaunch || (input.shellProfile && !shell) || input.hostLifecycle?.evictPtyId)
    throw new NativeTerminalPolicyError(
      "The native SSH terminal does not support this launch policy.",
    );
  return Object.freeze({
    pane: Object.freeze(pane),
    targetId,
    cwd,
    cols: input.cols,
    rows: input.rows,
    ...(shell === undefined ? {} : { shell }),
  });
}

export function makeNativeDirectSshTerminal(
  options: NativeDirectSshTerminalOptions,
  isDirect: (target: string) => boolean,
  isClosed: () => boolean,
) {
  const { port, owners } = options;
  const lifecycle = makeNativeDirectSshLifecycle(options, isClosed, isDirect);
  // The manager's runtime shape still requires agent plumbing. Neither call may route to an agent.
  const noAgentRoute = async (): Promise<never> => {
    throw new NativeTerminalPolicyError("Native direct SSH has no remote-agent control route.");
  };
  const pool = new RemoteAgentConnectionPool({ create: noAgentRoute });
  const runtimeForTarget = (targetId: string): OwnedPtyRuntime | undefined =>
    isDirect(targetId)
      ? {
          targetId,
          owners,
          pool,
          control: noAgentRoute,
          pidNamespace: "backend-host",
          localSshClient: lifecycle,
        }
      : undefined;
  const spawn: PtyAdapterShape["spawn"] = Effect.fn("localTerminalHost.directSsh.nativeSpawn")(
    function* (input) {
      return yield* Effect.tryPromise({
        try: async (fiberSignal) => {
          const signal = input.recoverySignal
            ? AbortSignal.any([fiberSignal, input.recoverySignal])
            : fiberSignal;
          const assertAvailable = () => {
            signal.throwIfAborted();
            if (isClosed()) throw new Error("The native SSH terminal transport is closed.");
          };
          assertAvailable();
          const targetId = input.executionTargetId;
          if (!targetId || !isDirect(targetId) || !identity(targetId))
            throw new NativeTerminalPolicyError("A direct SSH execution target is required.");
          const pane = paneOf(input.ownerKey);
          const key = `terminal:${input.ownerKey}`;
          const store = owners();
          const retained = await store.get(key);
          assertAvailable();
          if (retained?.target === targetId && isNativeDirectSshHostLost(retained))
            throw new NativeSshPtyHostLostError();
          if (
            retained &&
            input.replaceTerminalOwner &&
            !input.recoverOnly &&
            retained.state !== "terminal"
          )
            throw new NativeTerminalPolicyError(
              "The previous native SSH terminal is not confirmed stopped; no replacement was started.",
            );
          if (
            retained &&
            !(
              retained.state === "terminal" &&
              input.replaceTerminalOwner &&
              !input.recoverOnly &&
              retained.target === targetId &&
              input.expectedRemoteResourceId === undefined
            )
          ) {
            if (
              retained.target !== targetId ||
              retained.state === "terminal" ||
              retained.state === "prepared" ||
              (input.expectedRemoteResourceId !== undefined &&
                retained.resourceId !== input.expectedRemoteResourceId)
            )
              throw new NativeTerminalPolicyError(
                "The pane has no matching recoverable native SSH binding; no replacement was started.",
              );
            const binding = nativeDirectSshBinding(retained);
            const attached = await port.reattach(binding, signal).catch(async (cause: unknown) => {
              throw await observeNativeHostFailure(options, retained, cause);
            });
            return bindNativeDirectSshProcess(
              options,
              lifecycle,
              retained,
              attached,
              true,
              assertAvailable,
            );
          }
          if (input.recoverOnly || input.expectedRemoteResourceId !== undefined)
            throw new NativeTerminalPolicyError(
              "The pane has no retained native SSH binding; no replacement was started.",
            );

          const request = openRequest(input, targetId, pane, options.shellFor);
          const binding = await port.prepareOpen(request, signal);
          assertAvailable();
          if (
            binding.targetId !== targetId ||
            !identity(binding.ownerEpoch) ||
            !identity(binding.leaseId) ||
            !identity(binding.targetGeneration, 256 - NATIVE_SSH_CONNECTION_PREFIX.length)
          )
            throw new NativeTerminalPolicyError(
              "The native SSH owner returned an invalid binding.",
            );
          const reservationId = randomUUID();
          const route = await store.reserve(
            {
              ownerKey: key,
              reservationId,
              target: targetId,
              runtime: options.runtime,
              epoch: binding.ownerEpoch,
              connectionId: NATIVE_SSH_CONNECTION_PREFIX + binding.targetGeneration,
              resourceId: binding.leaseId,
              digest: Buffer.from(
                remoteAgentPtyRequestDigest({ target: targetId, cwd: request.cwd }),
              ).toString("hex"),
              terminalCwd: request.cwd,
              // Reserve the possibly dispatched state before the only operation that can spawn.
              // A crash, lost reply or failed observer never erases this fence.
              state: "may-have-been-sent",
              outputSequence: 0,
              nextInputSequence: 1,
              inputAcknowledged: 0,
            },
            retained?.state === "terminal" &&
              input.replaceTerminalOwner === true &&
              !input.recoverOnly,
            targetId,
            retained?.state === "terminal" ? retained : undefined,
          );
          if (route.reservationId !== reservationId)
            throw new NativeTerminalPolicyError(
              "Another request holds this pane's SSH binding; no duplicate dispatch was attempted.",
            );
          assertAvailable();
          const attached = await port
            .open(request, nativeDirectSshBinding(route), signal)
            .catch(async (cause: unknown) => {
              throw await observeNativeHostFailure(options, route, cause);
            });
          return bindNativeDirectSshProcess(
            options,
            lifecycle,
            route,
            attached,
            false,
            assertAvailable,
          );
        },
        // Do not leak transport detail or let executable errors trigger manager shell retries.
        catch: (cause) =>
          new PtySpawnError({
            adapter: "native-ssh-owner",
            message:
              cause instanceof NativeTerminalPolicyError ||
              cause instanceof NativeSshPtyHostLostError
                ? cause.message
                : "sshOwnerUnavailable: The native SSH terminal could not be confirmed; no replacement was started.",
          }),
      });
    },
  );
  return { runtimeForTarget, spawn, lifecycle };
}
