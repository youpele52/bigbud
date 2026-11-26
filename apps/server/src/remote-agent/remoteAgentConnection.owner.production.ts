import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import { PassThrough } from "node:stream";

import type { ClientRelayLeaseState } from "../ssh/sshOwnerPickerProof.codec.backend.ts";
import {
  bindRemoteAgentOwnerTarget,
  type RemoteAgentOwnerControlDependencies,
} from "./remoteAgentControl.owner.ts";
import type {
  RemoteAgentOwnedSshInput,
  RemoteAgentProxyExit,
  RemoteAgentProxyLease,
  RemoteAgentProxyOwner,
} from "./remoteAgentConnection.owner.ts";
import { remoteAgentOwnerSelection } from "./remoteAgentControl.selection.ts";
import { validateRemoteAgentRuntime, type RemoteAgentRuntime } from "./remoteAgentRuntime.ts";

const SETTLED = new Set(["exited", "closed", "lost", "unconfirmed"]);
const POLL_MS = 50;

/**
 * U25 production `RemoteAgentProxyOwner`: each connection is one owner proxy lease for the exact
 * registry runtime the pool resolved. The owner runs its installed-agent recipe, which re-checks
 * the private directories and the binary's SHA-256 on the opened descriptor before `--proxy`
 * runs; this process never builds an SSH command. Bytes flow over the owner's lease socket.
 */
export function makeProductionRemoteAgentProxyOwner(
  dependencies: RemoteAgentOwnerControlDependencies,
): RemoteAgentProxyOwner {
  return {
    async openAgentProxy(target, signal) {
      signal?.throwIfAborted();
      const runtime = validateRemoteAgentRuntime(target.runtime);
      const bound = await bindRemoteAgentOwnerTarget(dependencies, target.executionTargetId);
      const lease = randomBytes(32);
      const opened = await bound.openAgentProxyLease(lease, runtime);
      if (opened.phase !== "listening") {
        await bound.closeAgentProxyLease(lease).catch(() => undefined);
        throw new Error("The SSH owner did not open an agent proxy session.");
      }
      const socket = connect({ path: opened.socketPath, allowHalfOpen: true });
      try {
        await once(socket, "connect", signal ? { signal } : {});
      } catch (cause) {
        socket.destroy();
        await bound.closeAgentProxyLease(lease).catch(() => undefined);
        throw cause;
      }
      const settle = async (): Promise<ClientRelayLeaseState> => {
        for (;;) {
          const state = await bound.agentProxyLeaseStatus(lease);
          if (SETTLED.has(state.phase)) return state;
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
      };
      // Settles after the final readable bytes; a session without an exit status is lost.
      const exit = (async (): Promise<RemoteAgentProxyExit> => {
        if (!socket.destroyed) await once(socket, "close");
        const state = await settle();
        if (state.phase === "exited") return { code: state.exitCode, signal: null };
        if (state.phase === "closed") return { code: null, signal: "SIGTERM" };
        throw new Error(`Agent proxy session ended without an exit status (${state.phase}).`);
      })();
      exit.catch(() => undefined);
      const stderr = new PassThrough();
      stderr.end();
      const lease_: RemoteAgentProxyLease = {
        pipes: { stdin: socket, stdout: socket, stderr },
        exit,
        close: async ({ mode, timeoutMs }) => {
          if (mode === "graceful") {
            socket.end();
            const drained = await Promise.race([
              exit.then(
                () => true,
                () => true,
              ),
              new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
            ]);
            if (drained) return;
          }
          socket.destroy();
          const state = await bound.closeAgentProxyLease(lease);
          if (state.phase === "unconfirmed")
            throw new Error("The SSH owner could not confirm the agent proxy teardown.");
        },
      };
      return lease_;
    },
  };
}

/**
 * Under production activation, turn a legacy SSH proxy request into an owner proxy lease for the
 * same pinned runtime. An unpinned binary command has no owner equivalent and is refused.
 * Outside activation the input is returned unchanged.
 */
export function routeProductionRemoteAgentProxy<
  I extends
    | RemoteAgentOwnedSshInput
    | {
        readonly executionTargetId: string;
        readonly runtime?: RemoteAgentRuntime;
        readonly maxFrameBytes?: number;
      },
>(input: I, activation?: boolean): I | RemoteAgentOwnedSshInput {
  if ("owner" in input) return input;
  const production = remoteAgentOwnerSelection(activation);
  if (!production) return input;
  if (!input.runtime) throw new Error("The SSH owner proxies only a pinned agent runtime.");
  return {
    executionTargetId: input.executionTargetId,
    runtime: input.runtime,
    owner: makeProductionRemoteAgentProxyOwner(production),
    ...(input.maxFrameBytes !== undefined ? { maxFrameBytes: input.maxFrameBytes } : {}),
  };
}
