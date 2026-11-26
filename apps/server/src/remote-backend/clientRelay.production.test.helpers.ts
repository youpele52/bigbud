import * as fs from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClientRelayLeaseState } from "../ssh/sshOwnerPickerProof.codec.backend.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import { serveClientRelayStream } from "./clientRelay.remote.ts";

/**
 * A production-owner stand-in for the W2 T-backend relay tests. Each lease is a real
 * per-lease Unix socket, as with the owner; the accepted connection is served by the real
 * remote relay helper code against a private backend socket, standing in for the pinned
 * SSH child running the deployed helper.
 */
export interface FakeRelayOwner {
  readonly registration: SshOwnerProductionRegistration;
  readonly opened: number;
  readonly closed: number;
  readonly live: () => number;
  /** Settle later closes as unconfirmed. */
  unconfirmed: boolean;
  readonly cleanup: () => Promise<void>;
}

const key = (lease: Uint8Array) => Buffer.from(lease).toString("hex");

interface Lease {
  state: ClientRelayLeaseState;
  server: Server;
  peer?: Socket;
}

/** Echo every byte back only after the caller's end-of-input (a half-close probe). */
export function echoAfterEof(peer: Socket) {
  const chunks: Buffer[] = [];
  peer.on("data", (chunk: Buffer) => chunks.push(chunk));
  peer.once("end", () => peer.end(Buffer.concat([...chunks, Buffer.from(":eof")])));
  return { close: () => peer.destroy() };
}

export async function makeFakeRelayOwner(
  backendSocket: string,
  token: string,
  serve: (peer: Socket) => { close: () => void } = (peer) =>
    serveClientRelayStream({ stream: peer, socketPath: backendSocket, token }),
) {
  const root = await fs.mkdtemp(join(tmpdir(), "bb-prl-"));
  const leases = new Map<string, Lease>();
  let opened = 0;
  let closed = 0;
  const owner: FakeRelayOwner = {
    registration: undefined as unknown as SshOwnerProductionRegistration,
    get opened() {
      return opened;
    },
    get closed() {
      return closed;
    },
    live: () =>
      [...leases.values()].filter((l) => ["listening", "streaming"].includes(l.state.phase)).length,
    unconfirmed: false,
    async cleanup() {
      for (const lease of leases.values()) {
        lease.peer?.destroy();
        lease.server.close();
      }
      await fs.rm(root, { recursive: true, force: true });
    },
  };
  const bound = {
    async openClientRelayLease(lease: Uint8Array) {
      opened++;
      const socketPath = join(root, `${opened}.sock`);
      const entry: Lease = {
        state: { lease, phase: "listening", socketPath },
        server: createServer({ allowHalfOpen: true }, (peer) => {
          entry.server.close();
          entry.peer = peer;
          entry.state = { lease, phase: "streaming" };
          const helper = serve(peer);
          peer.once("close", () => {
            helper.close();
            if (entry.state.phase === "streaming")
              entry.state = { lease, phase: "exited", exitCode: 0 };
          });
        }),
      };
      leases.set(key(lease), entry);
      await new Promise<void>((resolve) => entry.server.listen(socketPath, resolve));
      return entry.state;
    },
    async clientRelayLeaseStatus(lease: Uint8Array) {
      const entry = leases.get(key(lease));
      if (!entry) throw new Error("operationDenied");
      return entry.state;
    },
    async closeClientRelayLease(lease: Uint8Array) {
      const entry = leases.get(key(lease));
      if (!entry) throw new Error("operationDenied");
      closed++;
      if (entry.state.phase === "listening" || entry.state.phase === "streaming") {
        entry.state = { lease, phase: owner.unconfirmed ? "unconfirmed" : "closed" };
        entry.server.close();
        entry.peer?.destroy();
      }
      return entry.state;
    },
  };
  (owner as { registration: SshOwnerProductionRegistration }).registration = {
    handle: { target: () => bound, state: () => "open" },
    descriptorFor: async () => ({ targetId: "fixture" }),
  } as unknown as SshOwnerProductionRegistration;
  return owner;
}
