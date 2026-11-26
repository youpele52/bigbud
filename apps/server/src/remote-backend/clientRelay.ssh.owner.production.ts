import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

import type { ClientRelayLeaseState } from "../ssh/sshOwnerPickerProof.codec.backend.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import type {
  ClientRelayOwnerExit,
  ClientRelayOwnerLease,
  ClientRelaySshOwner,
} from "./clientRelay.ssh.owner.ts";

/**
 * W2 T-backend production client relay route. Each channel is one owner relay lease on the
 * exact deployed target: the owner verifies the target's own trust, runs the persisted
 * profile's pinned relay helper and hands back one private socket. Bytes never cross the
 * owner's control pipe, so a slow viewer backpressures only its own channel. The live owner
 * is read per channel; without one the channel is refused, never launched another way.
 *
 * @module clientRelay.ssh.owner.production
 */

export interface ProductionClientRelayDependencies {
  readonly owner: () => SshOwnerProductionRegistration | undefined;
  /** Settlement poll after the channel closes; tests shorten it. */
  readonly pollMs?: { readonly first: number; readonly max: number; readonly limit: number };
}

type Bound = ReturnType<SshOwnerProductionRegistration["handle"]["target"]>;
const CLOSE_TIMEOUT_MS = 2_000;

function connectSocket(path: string, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path, allowHalfOpen: true });
    const abort = () => socket.destroy(signal.reason as Error);
    signal.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => {
      signal.removeEventListener("abort", abort);
      resolve(socket);
    });
    socket.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

/** Settled channel state as the relay lease exit contract. */
function exitOf(state: ClientRelayLeaseState): ClientRelayOwnerExit | undefined {
  switch (state.phase) {
    case "exited":
      return { kind: "exited", code: state.exitCode };
    // The owner confirmed the reap of a closed or ended channel.
    case "closed":
    case "lost":
      return { kind: "signaled", signal: "SIGKILL" };
    case "unconfirmed":
      throw new Error("The SSH owner could not confirm the relay channel's exit.");
    default:
      return undefined;
  }
}

async function settle(
  bound: Bound,
  lease: Uint8Array,
  poll: NonNullable<ProductionClientRelayDependencies["pollMs"]>,
): Promise<ClientRelayOwnerExit> {
  let wait = poll.first;
  for (let attempt = 0; attempt < poll.limit; attempt++) {
    const exit = exitOf(await bound.clientRelayLeaseStatus(lease));
    if (exit) return exit;
    await new Promise((resolve) => setTimeout(resolve, wait));
    wait = Math.min(wait * 2, poll.max);
  }
  // The socket closed but the owner never settled the child: close it and require proof.
  const closed = exitOf(await bound.closeClientRelayLease(lease));
  if (closed) return closed;
  throw new Error("The SSH owner did not settle the relay channel.");
}

export function makeProductionClientRelayOwner(
  dependencies: ProductionClientRelayDependencies,
): ClientRelaySshOwner {
  const poll = dependencies.pollMs ?? { first: 20, max: 500, limit: 40 };
  return Object.freeze<ClientRelaySshOwner>({
    async openClientRelay(request, signal) {
      signal.throwIfAborted();
      const live = dependencies.owner();
      if (!live) throw new Error("The SSH owner is not running.");
      const descriptor = await live.descriptorFor(request.executionTargetId);
      signal.throwIfAborted();
      const bound = live.handle.target(descriptor);
      const lease = randomBytes(32);
      const close = () =>
        Promise.race([
          bound.closeClientRelayLease(lease).then(
            () => undefined,
            () => undefined,
          ),
          new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
        ]).then(() => undefined);
      const state = await bound.openClientRelayLease(lease, request.deployment);
      let socket: Socket;
      try {
        if (state.phase !== "listening") throw new Error("The relay channel did not listen.");
        socket = await connectSocket(state.socketPath, signal);
      } catch (error) {
        await close();
        throw error;
      }
      socket.on("error", () => {});
      // The child's end-of-output (or a full close) is the reap signal; confirm it with
      // the owner. A half-open socket never closes while the caller still writes.
      const ended = new Promise<void>((resolve) => {
        socket.once("end", () => resolve());
        socket.once("close", () => resolve());
      });
      const exit = ended.then(() => settle(bound, lease, poll));
      void exit.catch(() => {});
      const ownerLease: ClientRelayOwnerLease = {
        stream: socket,
        exit,
        cancel: async () => {
          await close();
          socket.destroy();
        },
      };
      return ownerLease;
    },
  });
}
