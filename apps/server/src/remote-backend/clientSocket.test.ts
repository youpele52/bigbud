import * as fs from "node:fs/promises";
import net from "node:net";
import http from "node:http";
import { generateKeyPairSync } from "node:crypto";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ServiceMap } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";

import { assertSharedRemoteBootstrapLock } from "./clientSocket.lock.testHelpers.ts";
import { prepareRemoteMobileSocket } from "./mobileSocket.ts";
import { prepareRemoteClientSocket } from "./clientSocket.ts";
import { remoteClientSocketPath } from "../startup/config.remote.ts";
import { ServerConfig } from "../startup/config.ts";
import { RemoteCallbackHttpServerLive, remoteUnixHttpServerLive } from "../server.platform.ts";
import { serveIsolatedRemoteRoutes } from "../server.remote.listener.ts";
import { makeRemoteClientHandshakeRoute, remoteClientAuthorizationLive } from "./clientRoutes.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";

let root: string;
const held = async () => {};
const listen = (path: string) =>
  new Promise<net.Server>((resolve, reject) => {
    const server = net.createServer((socket) => socket.end());
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });
const close = (server: net.Server) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

beforeEach(async () => {
  root = await fs.mkdtemp(join(os.tmpdir(), "bb-rsock-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe.runIf(process.platform !== "win32")("private remote client socket", () => {
  it("serializes simultaneous client/mobile bootstrap commands through one shared lock", async () => {
    await assertSharedRemoteBootstrapLock(root);
  });

  it("publishes independent private client/mobile sockets and releases only its own endpoint", async () => {
    const client = await prepareRemoteClientSocket(root, held);
    const mobile = await prepareRemoteMobileSocket(root, held);
    const clientServer = await listen(client.bindPath);
    const mobileServer = await listen(mobile.bindPath);
    try {
      await client.seal();
      await mobile.seal();
      expect(client.path).not.toBe(mobile.path);
      expect((await fs.stat(client.path)).mode & 0o7777).toBe(0o600);
      expect((await fs.stat(mobile.path)).mode & 0o7777).toBe(0o600);
      await mobile.release();
      await expect(fs.lstat(mobile.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.stat(client.path)).isSocket()).toBe(true);
      await client.release();
    } finally {
      await close(mobileServer);
      await close(clientServer);
    }
  });

  it("isolates both live listener routers while retaining one shared issuer service", async () => {
    class Issuer extends ServiceMap.Service<Issuer, { readonly id: number }>()("fixture/Issuer") {}
    let issuerCreations = 0;
    let callbackPort = 0;
    const clientPath = join(root, "pair.sock");
    const issuerRoute = (path: `/${string}`) =>
      HttpRouter.add(
        "GET",
        path,
        Effect.gen(function* () {
          const issuer = yield* Issuer;
          return yield* HttpServerResponse.json({ issuer: issuer.id });
        }),
      );
    const clientRoutes = Layer.mergeAll(
      makeRemoteClientHandshakeRoute("1.0.0"),
      issuerRoute("/client-issuer"),
      HttpRouter.add("GET", "/ws", HttpServerResponse.text("client-only")),
    ).pipe(Layer.provide(remoteClientAuthorizationLive));
    const callbackRoutes = Layer.mergeAll(
      issuerRoute("/callback-issuer"),
      HttpRouter.add(
        "POST",
        "/api/internal/thread-tools",
        HttpServerResponse.empty({ status: 204 }),
      ),
    );
    const callbackTransport = Layer.effectDiscard(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        if (server.address._tag !== "TcpAddress") throw new Error("Expected callback TCP");
        callbackPort = server.address.port;
      }),
    ).pipe(Layer.provideMerge(RemoteCallbackHttpServerLive));
    const config = Layer.effect(
      ServerConfig,
      Effect.gen(function* () {
        const base = yield* ServerConfig;
        return { ...base, port: 0, authToken: "fixture-secret" };
      }).pipe(
        Effect.provide(ServerConfig.layerTest(root, root).pipe(Layer.provide(NodeServices.layer))),
      ),
    );
    const shared = Layer.mergeAll(
      Layer.effect(
        Issuer,
        Effect.sync(() => ({ id: ++issuerCreations })),
      ),
      Layer.succeed(RemoteBackendIdentityService, {
        authority: {
          authorityId: "a".repeat(32),
          keyEpoch: 1,
          keyFingerprint: `sha256:${"b".repeat(64)}`,
        },
        installationFingerprint: `sha256:${"c".repeat(64)}`,
        publicKey: generateKeyPairSync("ed25519").publicKey,
        signChallenge: () => new Uint8Array(),
      }),
    );
    const application = Layer.mergeAll(
      serveIsolatedRemoteRoutes(clientRoutes).pipe(
        Layer.provide(remoteUnixHttpServerLive(clientPath)),
      ),
      serveIsolatedRemoteRoutes(callbackRoutes).pipe(Layer.provide(callbackTransport)),
    ).pipe(Layer.provide(shared), Layer.provide(config));
    const request = (client: boolean, path: string, extra: http.RequestOptions = {}) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            ...(client ? { socketPath: clientPath } : { host: "127.0.0.1", port: callbackPort }),
            path,
            headers: {
              authorization: "Bearer fixture-secret",
              "x-bigbud-client-rpc-revision": "1",
            },
            ...extra,
          },
          (response) => {
            let body = "";
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () => resolve({ status: response.statusCode!, body }));
          },
        );
        req.once("upgrade", (_response, socket) => {
          socket.destroy();
          reject(new Error("Unexpected WebSocket upgrade"));
        });
        req.once("error", reject);
        req.setTimeout(3000, () => req.destroy(new Error("Listener request timed out")));
        req.end();
      });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(application);
          yield* Effect.promise(async () => {
            expect((await request(true, "/api/remote-backend/handshake")).status).toBe(200);
            expect((await request(false, "/api/remote-backend/handshake")).status).toBe(404);
            expect(
              (
                await request(false, "/ws?token=fixture-secret&clientRpcRevision=1", {
                  headers: {
                    connection: "Upgrade",
                    upgrade: "websocket",
                    "sec-websocket-version": "13",
                    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
                  },
                })
              ).status,
            ).toBe(404);
            expect(
              (await request(true, "/api/internal/thread-tools", { method: "POST" })).status,
            ).toBe(404);
            expect(
              (await request(false, "/api/internal/thread-tools", { method: "POST" })).status,
            ).toBe(204);
            const clientIssuer = await request(true, "/client-issuer");
            const callbackIssuer = await request(false, "/callback-issuer");
            expect(clientIssuer.body).toBe(callbackIssuer.body);
            expect(JSON.parse(clientIssuer.body)).toEqual({ issuer: 1 });
            expect(issuerCreations).toBe(1);
          });
        }),
      ),
    );
  });

  it("intrinsically binds callback TCP to IPv4 loopback even with an unresolved or public host", async () => {
    for (const host of [undefined, "0.0.0.0", "::"]) {
      const config = Layer.effect(
        ServerConfig,
        Effect.gen(function* () {
          const base = yield* ServerConfig;
          return { ...base, port: 0, host };
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(root, root).pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
      );
      const address = await Effect.runPromise(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer;
          return server.address;
        }).pipe(Effect.provide(RemoteCallbackHttpServerLive.pipe(Layer.provide(config)))),
      );
      expect(address._tag).toBe("TcpAddress");
      if (address._tag === "TcpAddress") {
        expect(address.hostname).toBe("127.0.0.1");
        expect(address.port).toBeGreaterThan(0);
      }
    }
  });

  it("seals an owned listener and removes only its own inode on release", async () => {
    const socket = await prepareRemoteClientSocket(root, held);
    const server = await listen(socket.bindPath);
    try {
      await socket.seal();
      expect((await fs.lstat(socket.path)).mode & 0o7777).toBe(0o600);
      const moved = `${socket.path}.moved`;
      await fs.rename(socket.path, moved);
      await fs.writeFile(socket.path, "replacement", { mode: 0o600 });
      await expect(socket.release()).rejects.toThrow("not an owned Unix socket");
      expect(await fs.readFile(socket.path, "utf8")).toBe("replacement");
    } finally {
      await close(server);
    }
    expect(await fs.readFile(socket.path, "utf8")).toBe("replacement");
  });

  it("preserves a replacement stable endpoint after actual HTTP server layer finalization", async () => {
    const socket = await prepareRemoteClientSocket(root, held);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* HttpServer.HttpServer;
        yield* Effect.promise(socket.seal);
        // Verify the published alias connects to the listener before simulating path replacement.
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              const client = net.createConnection(socket.path);
              client.once("connect", () => {
                client.destroy();
                resolve();
              });
              client.once("error", reject);
            }),
        );
        yield* Effect.promise(async () => {
          await fs.rename(socket.path, `${socket.path}.old`);
          await fs.writeFile(socket.path, "later-owner", { mode: 0o600 });
        });
      }).pipe(Effect.provide(remoteUnixHttpServerLive(socket.bindPath))),
    );
    expect(await fs.readFile(socket.path, "utf8")).toBe("later-owner");
    await expect(socket.release()).rejects.toThrow("not an owned Unix socket");
    expect(await fs.readFile(socket.path, "utf8")).toBe("later-owner");
  });

  it("refuses a live socket rather than stealing its endpoint", async () => {
    const path = remoteClientSocketPath(root);
    const server = await listen(path);
    const before = await fs.lstat(path);
    try {
      await expect(prepareRemoteClientSocket(root, held)).rejects.toThrow("live listener");
      expect((await fs.lstat(path)).ino).toBe(before.ino);
    } finally {
      await close(server);
    }
  });

  it("recovers only an owned stale socket after verifying refusal and the held lock", async () => {
    const path = remoteClientSocketPath(root);
    const server = await listen(path);
    await fs.rename(path, `${path}.stale`);
    await close(server);
    await fs.rename(`${path}.stale`, path);
    let checks = 0;
    const prepared = await prepareRemoteClientSocket(root, async () => {
      checks++;
    });
    expect(prepared.path).toBe(path);
    expect(checks).toBe(2);
    await expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves non-socket files and rejects unsafe roots before lock or socket writes", async () => {
    const path = remoteClientSocketPath(root);
    await fs.writeFile(path, "do not replace");
    await expect(prepareRemoteClientSocket(root, held)).rejects.toThrow("not an owned Unix socket");
    expect(await fs.readFile(path, "utf8")).toBe("do not replace");
    await fs.chmod(root, 0o755);
    let checked = false;
    await expect(
      prepareRemoteClientSocket(root, async () => {
        checked = true;
      }),
    ).rejects.toThrow();
    expect(checked).toBe(false);
  });

  it("does not remove a stale socket after losing the backend lock", async () => {
    const path = remoteClientSocketPath(root);
    const server = await listen(path);
    await fs.rename(path, `${path}.stale`);
    await close(server);
    await fs.rename(`${path}.stale`, path);
    let checks = 0;
    await expect(
      prepareRemoteClientSocket(root, async () => {
        if (++checks === 2) throw new Error("lock lost");
      }),
    ).rejects.toThrow("lock lost");
    expect((await fs.lstat(path)).isSocket()).toBe(true);
  });
});
