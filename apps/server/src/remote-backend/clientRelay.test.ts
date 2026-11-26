import { afterEach, expect, it } from "vitest";
import * as http from "node:http";
import { once } from "node:events";
import { PassThrough, type Duplex } from "node:stream";
import { clientRelayHeaders, clientRelayTarget } from "./clientRelay.headers.ts";
import { openClientRelayOwner } from "./clientRelay.owner.ts";
import { openClientRelaySocket } from "./clientRelay.owner.channel.ts";
import { backend, remote, request } from "./clientRelay.test.helpers.ts";
import { makeOwnedClientRelaySshChannels } from "./clientRelay.ssh.owner.ts";
import { makeProductionClientRelayOwner } from "./clientRelay.ssh.owner.production.ts";
import { echoAfterEof, makeFakeRelayOwner } from "./clientRelay.production.test.helpers.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
const revision = { "x-bigbud-client-rpc-revision": "1" };
it("strips hop-by-hop nominated headers, cookies and credentials", () => {
  expect(
    clientRelayHeaders({
      connection: "x-hidden",
      "x-hidden": "secret",
      authorization: "secret",
      cookie: "secret",
      "set-cookie": ["secret"],
      host: "elsewhere",
      "content-type": "text/plain",
    }),
  ).toEqual({ "content-type": "text/plain" });
  expect(clientRelayTarget("/asset?token=local&x=1&token=other")).toBe("/asset?x=1");
  for (const path of ["https://elsewhere/ws", "//elsewhere/ws", "/bad\\path", "/bad\npath"])
    expect(() => clientRelayTarget(path)).toThrow();
});
it("real UDS injects private auth, strips local token and streams HTTP without exposing credentials", async () => {
  const observed: unknown[] = [];
  const upstream = await backend((req, res) => {
    observed.push({ url: req.url, auth: req.headers.authorization, cookie: req.headers.cookie });
    res.setHeader("authorization", "private-backend-token");
    res.setHeader("set-cookie", "secret");
    res.end("asset-output");
  });
  cleanup.push(upstream.close);
  const helper = remote(upstream.socketPath, "private-backend-token");
  cleanup.push(helper.close);
  const response = await request(helper.stream, "/asset?token=local&file=x", {
    authorization: "Bearer local",
    cookie: "unsafe",
    ...revision,
  });
  expect(observed).toEqual([
    { url: "/asset?file=x", auth: "Bearer private-backend-token", cookie: undefined },
  ]);
  expect(response.status).toBe(200);
  expect(response.body).toBe("asset-output");
  expect(response.headers.authorization).toBeUndefined();
  expect(response.headers["set-cookie"]).toBeUndefined();
  expect(JSON.stringify(response)).not.toContain("private-backend-token");
});
it("real UDS WebSocket upgrade preserves head and bidirectional bytes with internal auth", async () => {
  const upstream = await backend((_req, res) => res.writeHead(404).end());
  cleanup.push(upstream.close);
  let authorization: string | undefined;
  upstream.server.on("upgrade", (req, socket, head) => {
    authorization = req.headers.authorization;
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: fixture\r\n\r\nhello",
    );
    if (head.length) socket.write(head);
    socket.on("data", (chunk) => socket.write(chunk));
  });
  const helper = remote(upstream.socketPath, "private-token");
  cleanup.push(helper.close);
  const owner = await openClientRelayOwner({
    allowedOrigins: ["https://app.example"],
    openChannel: async () => helper.stream,
  });
  cleanup.push(owner.dispose);
  const req = http.request(owner.baseUrl + `/ws?token=${owner.token}&clientRpcRevision=1`, {
    headers: { connection: "Upgrade", upgrade: "websocket", origin: "https://app.example" },
  });
  const upgraded = once(req, "upgrade");
  req.end();
  const [response, socket, head] = await upgraded;
  expect(response.statusCode).toBe(101);
  expect(authorization).toBe("Bearer private-token");
  let greeting: Buffer = head;
  while (greeting.length < 5) greeting = Buffer.concat([greeting, (await once(socket, "data"))[0]]);
  expect(greeting.toString()).toBe("hello");
  const echo = once(socket, "data");
  socket.write(Buffer.from([0, 1, 254, 255]));
  expect((await echo)[0]).toEqual(Buffer.from([0, 1, 254, 255]));
  const disconnected = once(socket, "close");
  owner.dispose();
  await disconnected;
});
it("loopback owner rejects missing credentials, foreign origins and host rebinding before SSH", async () => {
  let opens = 0;
  const owner = await openClientRelayOwner({
    allowedOrigins: ["https://app.example"],
    openChannel: async () => {
      opens++;
      return new PassThrough();
    },
  });
  cleanup.push(owner.dispose);
  expect((await fetch(owner.baseUrl + "/api/remote-backend/handshake")).status).toBe(401);
  expect(
    (
      await fetch(owner.baseUrl + "/api/remote-backend/handshake", {
        headers: { authorization: `Bearer ${owner.token}`, origin: "https://evil.example" },
      })
    ).status,
  ).toBe(403);
  const rebound = await new Promise<number>((resolve, reject) => {
    const req = http.get(
      owner.baseUrl + "/api/remote-backend/handshake",
      { headers: { authorization: `Bearer ${owner.token}`, host: "evil.example" } },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    );
    req.once("error", reject);
  });
  expect(rebound).toBe(403);
  expect(opens).toBe(0);
});
it("loopback owner forwards authenticated requests and reuses one SSH HTTP channel", async () => {
  let opens = 0;
  const seen: string[] = [];
  const upstream = await backend((req, res) => {
    seen.push(req.headers.authorization!);
    res.end("okay");
  });
  cleanup.push(upstream.close);
  const owner = await openClientRelayOwner({
    allowedOrigins: [],
    openChannel: async () => {
      opens++;
      return remote(upstream.socketPath, "real-private-token").stream;
    },
  });
  cleanup.push(owner.dispose);
  for (let index = 0; index < 2; index++) {
    const response = await fetch(owner.baseUrl + "/asset", {
      headers: { authorization: `Bearer ${owner.token}`, ...revision },
    });
    expect(await response.text()).toBe("okay");
  }
  expect(opens).toBe(1);
  expect(seen).toEqual(["Bearer real-private-token", "Bearer real-private-token"]);
});
it("preflight allows only explicit origins and supported headers without opening SSH", async () => {
  let opens = 0;
  const owner = await openClientRelayOwner({
    allowedOrigins: ["https://app.example"],
    openChannel: async () => {
      opens++;
      return new PassThrough();
    },
  });
  cleanup.push(owner.dispose);
  const response = await fetch(owner.baseUrl + "/asset", {
    method: "OPTIONS",
    headers: {
      origin: "https://app.example",
      "access-control-request-headers": "authorization, x-bigbud-client-rpc-revision, range",
    },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example");
  expect(response.headers.get("access-control-allow-headers")).toContain("range");
  expect(response.headers.get("access-control-allow-methods")).toContain("HEAD");
  expect(opens).toBe(0);
});
it("disposal fences an asynchronous channel that resolves after cancellation", async () => {
  let resolve!: (value: Duplex) => void;
  let signal!: AbortSignal;
  const socket = openClientRelaySocket((ownedSignal) => {
    signal = ownedSignal;
    return new Promise((done) => {
      resolve = done;
    });
  });
  socket.on("error", () => {});
  await Promise.resolve();
  socket.destroy();
  await once(socket, "close");
  expect(signal.aborted).toBe(true);
  const peer = new PassThrough();
  const peerClosed = once(peer, "close");
  resolve(peer);
  await peerClosed;
  expect(peer.destroyed).toBe(true);
});

/**
 * W2 T-backend production relay route: each channel is one owner relay lease on a real
 * per-lease Unix socket, served by the real remote helper code against a private backend.
 */
const deployment = {
  nodeBinary: "/home/dev/.bigbud/backend-graphs/x/graph/runtime/node",
  nodeSha256: "a".repeat(64),
  helperEntry: "/home/dev/.bigbud/backend-graphs/x/graph/server/remote-client-relay/r.mjs",
  helperSha256: "b".repeat(64),
  authorityId: "0123456789abcdef0123456789abcdef",
};
async function productionRelay(handler: http.RequestListener, echo = false) {
  const upstream = await backend(handler);
  cleanup.push(upstream.close);
  const owner = await makeFakeRelayOwner(
    upstream.socketPath,
    "private-backend-token",
    ...(echo ? [echoAfterEof] : []),
  );
  cleanup.push(owner.cleanup);
  const relayOwner = makeProductionClientRelayOwner({
    owner: () => owner.registration,
    pollMs: { first: 2, max: 10, limit: 20 },
  });
  const channels = makeOwnedClientRelaySshChannels(
    { executionTargetId: "ssh:host=vps.example&user=dev", deployment },
    relayOwner,
  );
  return { owner, channels, upstream };
}

it("production relay: parallel 512 KiB channels under a paused reader, then confirmed reap", async () => {
  const body = Buffer.alloc(512 * 1024, 7);
  const { owner, channels } = await productionRelay((_req, res) => res.end(body));
  const never = new AbortController().signal;
  // One channel is opened and never read: it must not stall the others.
  const paused = await channels.openChannel(never);
  paused.pause();
  paused.write("GET /paused HTTP/1.1\r\nHost: x\r\nx-bigbud-client-rpc-revision: 1\r\n\r\n");
  const responses = await Promise.all(
    Array.from({ length: 4 }, async () =>
      request(await channels.openChannel(never), "/blob", { connection: "close", ...revision }),
    ),
  );
  for (const response of responses) {
    expect(response.status).toBe(200);
    expect(response.body.length).toBe(body.length);
  }
  expect(owner.opened).toBe(5);
  await channels.dispose();
  expect(owner.live()).toBe(0);
});

it("production relay: a half-closed channel still delivers its suffix, then is reaped", async () => {
  const { owner, channels } = await productionRelay((_req, res) => res.end(), true);
  const channel = await channels.openChannel(new AbortController().signal);
  const chunks: Buffer[] = [];
  channel.on("data", (chunk: Buffer) => chunks.push(chunk));
  const payload = Buffer.alloc(256 * 1024, 3);
  channel.end(payload);
  await once(channel, "end");
  const received = Buffer.concat(chunks);
  expect(received.length).toBe(payload.length + 4);
  expect(received.subarray(-4).toString()).toBe(":eof");
  await channels.dispose();
  expect(owner.live()).toBe(0);
});

it("production relay: no owner refuses, and an unconfirmed close fails disposal", async () => {
  const absent = makeProductionClientRelayOwner({ owner: () => undefined });
  await expect(
    absent.openClientRelay(
      { executionTargetId: "ssh:host=vps.example&user=dev", deployment },
      new AbortController().signal,
    ),
  ).rejects.toThrow("not running");
  const { owner, channels } = await productionRelay((_req, res) => res.end("x"));
  const channel = await channels.openChannel(new AbortController().signal);
  owner.unconfirmed = true;
  channel.destroy();
  await expect(channels.dispose()).rejects.toThrow("exit confirmation");
  expect(owner.closed).toBeGreaterThan(0);
});
