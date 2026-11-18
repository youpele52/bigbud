import * as http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Duplex } from "node:stream";

import { PEER_ROUTE_PATHS } from "@bigbud/contracts/constants/remotePeer.constant.ts";
import { afterEach, describe, expect, it } from "vitest";

import { ClientRelayStdioSocket } from "./clientRelay.stdio.ts";
import { runPeerRelay } from "./peerRelay.entry.ts";
import { parsePeerRelayArguments } from "./peerRelay.remote.ts";
import { sendPeerRequest } from "./peerRelay.request.ts";

const WORKER = "c".repeat(32);
const GRANT = "00000001-0000-4000-8000-000000000001";
const COORDINATOR = "a".repeat(32);
const KEY = `sha256:${"b".repeat(64)}`;
const ARGV = [WORKER, GRANT, COORDINATOR, KEY];

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.toReversed()) await step();
  cleanup = [];
});

/** A temp Unix socket standing in for the worker's peer socket; records what reaches it. */
async function peerSocket() {
  const dir = await mkdtemp(join(tmpdir(), "peer-relay-"));
  const path = join(dir, "remote-peer.sock");
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body,
      });
      response.writeHead(200, { "content-type": "application/json", "set-cookie": "x=1" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanup.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { path, seen };
}

/** One forced-command invocation, exactly as sshd would start it, over an in-memory channel. */
async function channel(socketPath: string, argv: ReadonlyArray<string> = ARGV) {
  // Two pipes, as ssh gives the helper: coordinator writes its stdin and reads its stdout.
  const toHelper = new PassThrough();
  const fromHelper = new PassThrough();
  const coordinator: Duplex = new ClientRelayStdioSocket(fromHelper, toHelper);
  // When the helper drops the channel, ssh would exit and close the coordinator's pipes.
  fromHelper.once("close", () => coordinator.destroy());
  const resolved: string[] = [];
  await runPeerRelay({
    argv,
    stdin: toHelper,
    stdout: fromHelper,
    resolveSocket: async (authority) => {
      resolved.push(authority);
      return socketPath;
    },
  });
  return { coordinator, resolved };
}

function rawRequest(stream: Duplex, options: http.RequestOptions): Promise<number | "destroyed"> {
  return new Promise((resolve) => {
    const request = http.request({ ...options, createConnection: () => stream });
    request.once("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("error", () => resolve("destroyed"));
    request.end(options.method === "GET" ? undefined : "{}");
  });
}

describe("peer forced-command helper", () => {
  it("forced_command_only_reaches_peer_socket", async () => {
    const socket = await peerSocket();
    // Allowed: each peer route reaches the socket with the helper's own credential, whatever
    // credential, bearer or cookie the coordinator tried to send.
    for (const action of ["delegate", "status", "follow", "cancel"] as const) {
      const { coordinator, resolved } = await channel(socket.path);
      const forged = await new Promise<number>((resolve, reject) => {
        const request = http.request({
          createConnection: () => coordinator,
          method: "POST",
          path: PEER_ROUTE_PATHS[action],
          headers: {
            "content-type": "application/json",
            authorization: "Bearer stolen-client-token",
            cookie: "session=1",
            "x-bigbud-peer-grant": "99999999-0000-4000-8000-000000000009",
            "x-bigbud-peer-key": `sha256:${"f".repeat(64)}`,
          },
        });
        request.once("response", (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        request.once("error", reject);
        request.end(JSON.stringify({ dispatchId: GRANT }));
      });
      expect(forged).toBe(200);
      expect(resolved).toEqual([WORKER]);
    }
    expect(socket.seen.map((entry) => entry.url)).toEqual(Object.values(PEER_ROUTE_PATHS));
    for (const entry of socket.seen) {
      expect(entry.method).toBe("POST");
      expect(entry.headers["x-bigbud-peer-grant"]).toBe(GRANT);
      expect(entry.headers["x-bigbud-peer-coordinator"]).toBe(COORDINATOR);
      expect(entry.headers["x-bigbud-peer-key"]).toBe(KEY);
      expect(entry.headers.authorization).toBeUndefined();
      expect(entry.headers.cookie).toBeUndefined();
    }
    // The coordinator-side request helper works over the same channel shape.
    const viaHelper = await sendPeerRequest((await channel(socket.path)).coordinator, "status", {
      dispatchId: GRANT,
    });
    expect(viaHelper).toEqual({ status: 200, body: { ok: true } });
    const reached = socket.seen.length;
    // Refused locally: client RPC, websocket upgrades, other methods and unknown paths.
    const refusals = [
      { method: "GET", path: "/ws", headers: { connection: "Upgrade", upgrade: "websocket" } },
      { method: "POST", path: "/api/remote-backend/handshake" },
      { method: "POST", path: "/api/remote-backend/peer-grants" },
      { method: "GET", path: PEER_ROUTE_PATHS.status },
      { method: "POST", path: `${PEER_ROUTE_PATHS.status}?x=1` },
      { method: "POST", path: "/api/peer/v1/../../ws" },
      {
        method: "POST",
        path: PEER_ROUTE_PATHS.delegate,
        headers: { "content-length": String(10 * 1024 * 1024) },
      },
    ];
    for (const options of refusals) {
      const { coordinator } = await channel(socket.path);
      const status = await rawRequest(coordinator, options);
      expect([404, 413, "destroyed"], options.path).toContain(status);
    }
    expect(socket.seen).toHaveLength(reached);
  });

  it("accepts only the exact forced-command argument shape", async () => {
    expect(parsePeerRelayArguments(ARGV).credential).toEqual({
      grantId: GRANT,
      coordinatorAuthorityId: COORDINATOR,
      keyFingerprint: KEY,
    });
    for (const argv of [
      [],
      ARGV.slice(0, 3),
      [...ARGV, "extra"],
      [WORKER, "../grant", COORDINATOR, KEY],
      [WORKER, GRANT, COORDINATOR, "sha256:short"],
      ["/tmp/x", GRANT, COORDINATOR, KEY],
    ])
      expect(() => parsePeerRelayArguments(argv)).toThrow();
    const socket = await peerSocket();
    await expect(channel(socket.path, [WORKER, GRANT])).rejects.toThrow();
  });
});
