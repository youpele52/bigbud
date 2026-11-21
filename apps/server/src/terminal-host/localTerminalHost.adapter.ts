import { Effect } from "effect";

import { isLocalExecutionTarget } from "../executionTargets.ts";
import { RemoteAgentConnectionPool } from "../remote-agent/remoteAgentConnectionPool.ts";
import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import { makeOwnedRemoteAgentPty } from "../remote-agent/remoteAgentOwnedPty.ts";
import { makeRemoteAgentHostControls } from "../remote-agent/remoteAgentPtyClient.lifecycle.ts";
import { RemoteAgentPtyError } from "../remote-agent/remoteAgentPtyClient.types.ts";
import type { OwnedPtyRuntime } from "../terminal/Services/OwnedPtyRuntime.ts";
import { PtySpawnError, type PtyAdapterShape } from "../terminal/Services/PTY.ts";
import { makeLocalTerminalHostGenerations } from "./localTerminalHost.generations.ts";
import type { LocalTerminalHostController } from "./localTerminalHost.host.ts";
import {
  makeLocalTerminalHostOwners,
  makeLocalTerminalHostPinRegistry,
} from "./localTerminalHost.owners.ts";
import { LOCAL_TERMINAL_HOST_TARGET_ID } from "./localTerminalHost.paths.ts";
import { assertSecureLocalTerminalHostSocket } from "./localTerminalHost.probe.ts";
import {
  LOCAL_TERMINAL_HOST_LIFECYCLE,
  localTerminalHostLaunchEnvironment,
  localTerminalHostShellHost,
  localTerminalHostShellLaunch,
  planLocalTerminalHostLaunch,
  type LocalTerminalHostLaunchSpec,
} from "./localTerminalHost.launchSpec.ts";
import {
  makeLocalTerminalHostTransportFactory,
  type LocalTerminalHostConnect,
} from "./localTerminalHost.transport.ts";

export interface LocalTerminalHostAdapterOptions {
  readonly controller: LocalTerminalHostController;
  readonly owners: RemoteAgentOwnerStore;
  /** The in-process adapter: non-local targets, ownerless spawns, and no admitted host. */
  readonly fallback: PtyAdapterShape;
  /** The server state directory; host terminals' hook paths must live under it (S6). */
  readonly stateDir: string;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
  readonly connect?: LocalTerminalHostConnect;
  readonly assertSocket?: (socketPath: string) => Promise<void>;
}

/**
 * Local terminals with a durable owner go to the Rust host. Each owner reattaches through the
 * generation binding stored in its row; new owners bind to the admitted generation. Nothing here
 * can start or stop a host process; only the controller launches, and only lazily.
 */
export function makeLocalTerminalHostPtyAdapter(options: LocalTerminalHostAdapterOptions) {
  const { controller } = options;
  const owners = makeLocalTerminalHostOwners(options.owners);
  const registry = makeLocalTerminalHostPinRegistry(controller.knownRuntimes);
  const pool = new RemoteAgentConnectionPool(
    makeLocalTerminalHostTransportFactory({
      resolveBinding: controller.resolveAdmittedBinding,
      proxyBinary: controller.proxyBinary,
      assertSocket: options.assertSocket ?? assertSecureLocalTerminalHostSocket,
      ...(options.connect ? { connect: options.connect } : {}),
    }),
  );
  let closed = false;
  const runtime: OwnedPtyRuntime = Object.freeze({
    targetId: LOCAL_TERMINAL_HOST_TARGET_ID,
    pool,
    owners: () => owners,
    control: async () => ({ registry }),
    pidNamespace: "backend-host",
    // Host-wide controls address the admitted generation only and never launch a host.
    host: makeRemoteAgentHostControls(async () => {
      const binding = await controller.currentAdmittedBinding();
      if (!binding)
        throw new RemoteAgentPtyError("HOST_UNAVAILABLE", "No local terminal host is running.");
      return pool.getBound(LOCAL_TERMINAL_HOST_TARGET_ID, binding, ["terminal.pty"]);
    }),
    // Quit close-all, policy and inventory reach draining generations too.
    hostGenerations: makeLocalTerminalHostGenerations({
      controller,
      pool,
      ...(options.log ? { log: options.log } : {}),
    }),
  });
  const assertTarget = (target: string) => {
    if (target !== LOCAL_TERMINAL_HOST_TARGET_ID)
      throw new Error("The terminal belongs to another execution target.");
  };
  const spawnOwned = makeOwnedRemoteAgentPty(
    pool,
    runtime.owners,
    async (target) => {
      assertTarget(target);
      return controller.resolveAdmittedBinding();
    },
    {
      openControl: async (target) => {
        assertTarget(target);
        return runtime.control();
      },
      resolveShellHost: localTerminalHostShellHost,
      hostLifecycle: LOCAL_TERMINAL_HOST_LIFECYCLE,
      localLaunchEnvironment: (spawnInput) =>
        localTerminalHostLaunchEnvironment(spawnInput.env, spawnInput.cwd),
    },
  );
  const adapter: PtyAdapterShape = {
    ownedRuntimeForTarget: (target) => (isLocalExecutionTarget(target) ? runtime : undefined),
    spawn: Effect.fn("localTerminalHost.spawn")(function* (input) {
      if (!isLocalExecutionTarget(input.executionTargetId) || !input.ownerKey)
        return yield* options.fallback.spawn(input);
      let spec: LocalTerminalHostLaunchSpec | undefined;
      if (!input.recoverOnly) {
        const existing = yield* Effect.tryPromise({
          try: () => owners.get(`terminal:${input.ownerKey}`),
          catch: (cause) => hostSpawnError(cause),
        });
        const retained = existing !== undefined && existing.state !== "terminal";
        // No retained host owner and no admitted host (kill switch, launch failure): in-process.
        if (!retained) {
          // Decided before any host launch: a terminal the host cannot start unchanged stays local.
          const plan = yield* Effect.try({
            try: () => planLocalTerminalHostLaunch(input, { stateDir: options.stateDir }),
            catch: hostSpawnError,
          });
          if (plan.kind === "in-process") {
            options.log?.("A terminal runs in-process: its launch cannot move to the host.", {
              reason: plan.reason,
            });
            return yield* options.fallback.spawn(input);
          }
          spec = plan.spec;
          const binding = yield* Effect.promise(() =>
            controller.resolveAdmittedBinding().catch(() => undefined),
          );
          if (!binding) return yield* options.fallback.spawn(input);
        }
      }
      return yield* Effect.tryPromise({
        try: async (signal) => {
          if (closed) throw new Error("The local terminal host transport is closed.");
          const ownedInput = {
            ...input,
            executionTargetId: LOCAL_TERMINAL_HOST_TARGET_ID,
            remoteCwd: input.cwd,
          };
          // Cold recovery uses only durable intent; current defaults cannot replace it.
          if (input.recoverOnly) {
            delete ownedInput.shellLaunch;
            ownedInput.recoverySignal = signal;
          } else ownedInput.shellLaunch = spec?.shellLaunch ?? localTerminalHostShellLaunch(input);
          const process = await spawnOwned(ownedInput);
          if (input.recoverOnly && signal.aborted) {
            process.detach?.();
            signal.throwIfAborted();
          }
          return process;
        },
        catch: hostSpawnError,
      });
    }),
  };
  return {
    adapter,
    runtime,
    close: () => {
      closed = true;
      pool.closeAll();
    },
  };
}

function hostSpawnError(cause: unknown) {
  return new PtySpawnError({
    adapter: "local-terminal-host",
    message: cause instanceof Error ? cause.message : "The local terminal host is unavailable.",
    cause,
  });
}
