import { Effect } from "effect";
import { isLocalExecutionTarget } from "../executionTargets.ts";
import {
  RemoteAgentConnectionPool,
  type RemoteAgentRuntimeBinding,
} from "../remote-agent/remoteAgentConnectionPool.ts";
import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import type { RemoteAgentControl } from "../remote-agent/remoteAgentControl.ts";
import { makeOwnedRemoteAgentPty } from "../remote-agent/remoteAgentOwnedPty.ts";
import { PtySpawnError, type PtyAdapterShape } from "../terminal/Services/PTY.ts";
import type { OwnedPtyRuntime } from "../terminal/Services/OwnedPtyRuntime.ts";
import {
  makeLocalSupervisorTransportFactory,
  type LocalSupervisorTransportOptions,
} from "./localSupervisorTransport.ts";
import { localSupervisorShellHost, localSupervisorTarget } from "./localSupervisorIdentity.ts";
import { localSupervisorLaunch } from "./localSupervisorLaunch.ts";

export interface LocalSupervisorPtyOptions {
  readonly authorityId: string;
  readonly resolveBinding: () => Promise<RemoteAgentRuntimeBinding | undefined>;
  readonly owners: RemoteAgentOwnerStore;
  readonly registry: RemoteAgentControl["registry"];
  readonly transport?: Pick<LocalSupervisorTransportOptions, "connect" | "verifyRuntime">;
}

/** No supervisor start/stop authority: this adapter owns only proxy connections and observers. */
export function makeLocalSupervisorPty(options: LocalSupervisorPtyOptions) {
  const targetId = localSupervisorTarget(options.authorityId);
  const transport = makeLocalSupervisorTransportFactory({
    ...options.transport,
    targetId,
    resolveBinding: options.resolveBinding,
  });
  const pool = new RemoteAgentConnectionPool(transport);
  let closed = false;
  const runtime: OwnedPtyRuntime = Object.freeze({
    targetId,
    pool,
    owners: () => options.owners,
    control: async () => ({ registry: options.registry }),
    pidNamespace: "backend-host",
  });
  const spawnOwned = makeOwnedRemoteAgentPty(
    pool,
    runtime.owners,
    async (target) => {
      if (target !== targetId)
        throw new Error("The terminal belongs to another backend authority.");
      return options.resolveBinding();
    },
    {
      openControl: async (target) => {
        if (target !== targetId)
          throw new Error("The terminal registry belongs to another backend authority.");
        return runtime.control();
      },
      resolveShellHost: localSupervisorShellHost,
    },
  );
  const adapter: PtyAdapterShape = {
    ownedRuntimeForTarget: (target) => (isLocalExecutionTarget(target) ? runtime : undefined),
    spawn: Effect.fn("localSupervisorPty.spawn")(function* (input) {
      return yield* Effect.tryPromise({
        try: async (signal) => {
          if (closed) throw new Error("The local supervisor transport is closed.");
          if (!isLocalExecutionTarget(input.executionTargetId))
            throw new Error("The local supervisor cannot address another execution target.");
          if (!input.ownerKey) throw new Error("A durable application terminal owner is required.");
          const ownedInput = { ...input, executionTargetId: targetId, remoteCwd: input.cwd };
          // Cold recovery uses only durable intent; current defaults cannot replace it.
          if (input.recoverOnly) {
            delete ownedInput.shellLaunch;
            ownedInput.recoverySignal = signal;
          } else ownedInput.shellLaunch = localSupervisorLaunch(input, targetId);
          const process = await spawnOwned(ownedInput);
          if (input.recoverOnly && signal.aborted) {
            process.detach?.();
            signal.throwIfAborted();
          }
          return process;
        },
        catch: (cause) =>
          new PtySpawnError({
            adapter: "local-supervisor",
            message:
              cause instanceof Error ? cause.message : "The local Rust terminal is unavailable.",
            cause,
          }),
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
