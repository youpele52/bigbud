/**
 * Direct SSH through the local terminal host (plan M7, §7.2). A Direct SSH pane's PTY is a local
 * `ssh -tt` client, so it can live in the local Rust host like a local shell: it survives backend
 * restarts and, in keep mode, app quits, while the connection lives. The host cannot see the
 * remote foreground program, so these PTYs are created with `activity_source = owner-hint` and
 * the server pushes busy hints from remote inspection (§8.5).
 *
 * The launch is the exact command the in-process terminal would run (the server-built `ssh`
 * invocation with an absolute client path, the full local environment, cwd = home); a launch the
 * host cannot run unchanged stays in-process. The runtime handed to the manager is the host's,
 * marked with `localSshClient`, whose status and close address one owner's host PTY directly so
 * forget and delete can verify or end a pane no session holds.
 *
 * @module localTerminalHost.directSsh
 */
import { homedir } from "node:os";
import { basename } from "node:path";
import { Effect } from "effect";

import type { RemoteAgentConnectionPool } from "../remote-agent/remoteAgentConnectionPool.ts";
import { isRemoteAgentExecutionTarget } from "../remote-agent/remoteAgentDefault.ts";
import { makeOwnedRemoteAgentPty } from "../remote-agent/remoteAgentOwnedPty.ts";
import type { RemoteAgentOwner } from "../remote-agent/remoteAgentOwners.ts";
import type { RemoteAgentPtyCreateDefaults } from "../remote-agent/remoteAgentPtyClient.lifecycle.ts";
import type { RemoteAgentCommandLaunch } from "../remote-agent/remoteAgentTerminalLaunch.ts";
import { parseSshExecutionTarget } from "../ssh/sshExecutionTarget.ts";
import { isSshOwnerSelected, LegacySshDisabledError } from "../ssh/sshOwnerSelection.ts";
import type { OwnedPtyRuntime } from "../terminal/Services/OwnedPtyRuntime.ts";
import {
  PtySpawnError,
  type PtyAdapterShape,
  type PtySpawnInput,
} from "../terminal/Services/PTY.ts";
import { resolveCommandPath } from "../utils/commandPath.ts";
import type { LocalTerminalHostController } from "./localTerminalHost.host.ts";
import {
  LocalTerminalHostLaunchSpecError,
  localTerminalHostLaunchEnvironment,
  localTerminalHostPlatform,
} from "./localTerminalHost.launchSpec.ts";
import { makeLocalTerminalHostSshClient } from "./localTerminalHost.directSsh.client.ts";
import { paneIdentityForOwnerKey } from "./localTerminalHost.retirement.ts";
import {
  makeNativeDirectSshTerminal,
  type NativeDirectSshTerminalOptions,
} from "./localTerminalHost.directSsh.owner.ts";
import { LOCAL_TERMINAL_HOST_TARGET_ID } from "./localTerminalHost.paths.ts";

/** Lifecycle-managed like every host PTY; idle facts come from the server's owner hints. */
export const LOCAL_TERMINAL_HOST_DIRECT_SSH_LIFECYCLE: RemoteAgentPtyCreateDefaults = Object.freeze(
  { lifecycleManaged: true, localLaunch: true, activitySource: "owner-hint" },
);

/** An SSH target without the remote agent: its terminal is a local `ssh` client. */
export function isDirectSshTerminalTarget(target: string | undefined): boolean {
  return (
    target !== undefined &&
    parseSshExecutionTarget(target) !== null &&
    !isRemoteAgentExecutionTarget(target)
  );
}

export type DirectSshHostLaunchPlan =
  | { readonly kind: "host"; readonly command: RemoteAgentCommandLaunch; readonly cwd: string }
  | { readonly kind: "in-process"; readonly reason: string };

/** Whether this `ssh` launch can run in the host unchanged; it never changes the command. */
export function planDirectSshHostLaunch(
  input: Pick<PtySpawnInput, "shell" | "args" | "env">,
  options: { readonly home?: string; readonly platform?: NodeJS.Platform } = {},
): DirectSshHostLaunchPlan {
  const home = options.home ?? homedir();
  try {
    const platform = localTerminalHostPlatform(options.platform);
    if (basename(input.shell) !== "ssh")
      return { kind: "in-process", reason: "Only an ssh client runs as a Direct SSH host PTY." };
    const shell = input.shell.startsWith("/")
      ? input.shell
      : resolveCommandPath(input.shell, { platform, env: input.env });
    if (!shell) return { kind: "in-process", reason: "The ssh client is not on PATH." };
    // Validates the size limits the host enforces for a local launch.
    localTerminalHostLaunchEnvironment(input.env, home);
    return { kind: "host", command: { shell, args: [...(input.args ?? [])] }, cwd: home };
  } catch (cause) {
    if (cause instanceof LocalTerminalHostLaunchSpecError)
      return { kind: "in-process", reason: cause.message };
    throw cause;
  }
}

export interface LocalTerminalHostDirectSshOptions {
  readonly controller: LocalTerminalHostController;
  readonly pool: RemoteAgentConnectionPool;
  /** The local host runtime (owners, pin registry, host-wide controls). */
  readonly runtime: OwnedPtyRuntime;
  readonly fallback: PtyAdapterShape;
  readonly isClosed: () => boolean;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
  readonly home?: string;
  /** Isolated opt-in. The selected owner is the only direct SSH terminal authority. */
  readonly nativeOwner?: NativeDirectSshTerminalOptions;
}

type DirectSshAdapter = Pick<PtyAdapterShape, "spawn"> & {
  readonly runtimeForTarget: (targetId: string) => OwnedPtyRuntime | undefined;
};

export function makeLocalTerminalHostDirectSsh(
  options: LocalTerminalHostDirectSshOptions & { readonly nativeOwner?: never },
): DirectSshAdapter & { readonly runtime: OwnedPtyRuntime };
export function makeLocalTerminalHostDirectSsh(
  options: LocalTerminalHostDirectSshOptions,
): DirectSshAdapter;
export function makeLocalTerminalHostDirectSsh(
  options: LocalTerminalHostDirectSshOptions,
): DirectSshAdapter | (DirectSshAdapter & { readonly runtime: OwnedPtyRuntime }) {
  const { controller, runtime: base, nativeOwner } = options;
  if (nativeOwner)
    return makeNativeDirectSshTerminal(nativeOwner, isDirectSshTerminalTarget, options.isClosed);
  const home = options.home ?? homedir();
  const runtime: OwnedPtyRuntime = Object.freeze({
    ...base,
    localSshClient: makeLocalTerminalHostSshClient({
      controller,
      pool: options.pool,
      owners: base.owners,
      control: base.control,
      inventory: async (signal) => (await base.hostGenerations?.inventory(signal)) ?? [],
    }),
  });
  const assertTarget = (target: string) => {
    if (target !== LOCAL_TERMINAL_HOST_TARGET_ID)
      throw new Error("The terminal belongs to another execution target.");
  };
  const spawnOwned = makeOwnedRemoteAgentPty(
    options.pool,
    base.owners,
    async (target) => {
      assertTarget(target);
      return controller.resolveAdmittedBinding();
    },
    {
      openControl: async (target) => {
        assertTarget(target);
        return base.control();
      },
      hostLifecycle: LOCAL_TERMINAL_HOST_DIRECT_SSH_LIFECYCLE,
      localLaunchEnvironment: (input) => localTerminalHostLaunchEnvironment(input.env, input.cwd),
      commandLaunch: (input) => ({ shell: input.shell, args: [...(input.args ?? [])] }),
      paneIdentity: (input) =>
        paneIdentityForOwnerKey(input.ownerKey, "managed-ssh") ?? {
          threadId: "",
          paneId: "",
          kind: "managed-ssh",
        },
    },
  );
  const retainedOwner = (input: PtySpawnInput) =>
    Effect.tryPromise({
      try: async (): Promise<RemoteAgentOwner | undefined> => {
        const owner = await base.owners().get(`terminal:${input.ownerKey}`);
        return owner && owner.state !== "terminal" ? owner : undefined;
      },
      catch: directSshSpawnError,
    });

  const spawn: PtyAdapterShape["spawn"] = Effect.fn("localTerminalHost.directSsh.spawn")(
    function* (input) {
      if (isSshOwnerSelected()) return yield* directSshSpawnError(new LegacySshDisabledError());
      if (!input.ownerKey) return yield* options.fallback.spawn(input);
      let command: RemoteAgentCommandLaunch | undefined;
      if (!input.recoverOnly) {
        const retained = yield* retainedOwner(input);
        // A local shell the host still runs for this pane is never reinterpreted as SSH.
        if (retained?.shellLaunch)
          return yield* new PtySpawnError({
            adapter: "local-terminal-host",
            message:
              "This pane still runs a local terminal in the terminal host. Close it before opening an SSH terminal here.",
          });
        const plan = yield* Effect.try({
          try: () => planDirectSshHostLaunch(input, { home }),
          catch: directSshSpawnError,
        });
        if (plan.kind === "host") command = plan.command;
        // A retained host PTY is reattached even when a new launch could not move to the host.
        if (!retained) {
          if (plan.kind === "in-process") {
            options.log?.("An SSH terminal runs in-process: its launch cannot move to the host.", {
              reason: plan.reason,
            });
            return yield* options.fallback.spawn(input);
          }
          const binding = yield* Effect.promise(() =>
            controller.resolveAdmittedBinding().catch(() => undefined),
          );
          if (!binding) return yield* options.fallback.spawn(input);
        }
      }
      return yield* Effect.tryPromise({
        try: async (signal) => {
          if (options.isClosed()) throw new Error("The local terminal host transport is closed.");
          const { shellLaunch: _launch, shellProfile: _profile, ...rest } = input;
          const process = await spawnOwned({
            ...rest,
            ...(command ? { shell: command.shell, args: [...command.args] } : {}),
            executionTargetId: LOCAL_TERMINAL_HOST_TARGET_ID,
            cwd: home,
            remoteCwd: home,
            ...(input.recoverOnly ? { recoverySignal: signal } : {}),
          });
          if (input.recoverOnly && signal.aborted) {
            process.detach?.();
            signal.throwIfAborted();
          }
          return process;
        },
        catch: directSshSpawnError,
      });
    },
  );
  return {
    runtime,
    runtimeForTarget: (targetId: string) =>
      isDirectSshTerminalTarget(targetId) ? runtime : undefined,
    spawn,
  };
}

function directSshSpawnError(cause: unknown) {
  return new PtySpawnError({
    adapter: "local-terminal-host",
    message: cause instanceof Error ? cause.message : "The local terminal host is unavailable.",
    cause,
  });
}
