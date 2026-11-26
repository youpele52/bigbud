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
import { Effect } from "effect";

import type { RemoteAgentConnectionPool } from "../remote-agent/remoteAgentConnectionPool.ts";
import { isRemoteAgentExecutionTarget } from "../remote-agent/remoteAgentDefault.ts";
import type { RemoteAgentPtyCreateDefaults } from "../remote-agent/remoteAgentPtyClient.lifecycle.ts";
import { parseSshExecutionTarget } from "../ssh/sshExecutionTarget.ts";
import { SshOwnerRequiredError } from "../ssh/sshOwnerRequired.ts";
import type { OwnedPtyRuntime } from "../terminal/Services/OwnedPtyRuntime.ts";
import { PtySpawnError, type PtyAdapterShape } from "../terminal/Services/PTY.ts";
import type { LocalTerminalHostController } from "./localTerminalHost.host.ts";
import { makeLocalTerminalHostSshClient } from "./localTerminalHost.directSsh.client.ts";
import {
  makeNativeDirectSshTerminal,
  type NativeDirectSshTerminalOptions,
} from "./localTerminalHost.directSsh.owner.ts";

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
  // A direct SSH pane runs only through the Rust owner (`nativeOwner`). Without
  // it the pane is refused typed: the host never launches a local `ssh` client.
  const spawn: PtyAdapterShape["spawn"] = () =>
    Effect.fail(directSshSpawnError(new SshOwnerRequiredError()));
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
