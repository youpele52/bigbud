import { mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import { remoteUnixHttpServerLive } from "./server.platform.ts";
import { HTTP_GRACEFUL_SHUTDOWN_MS } from "./server.platform.nodeHttp.ts";
import { serveIsolatedRemoteRoutes } from "./server.remote.listener.ts";

/** A WebSocket route that holds its connection until its fiber is interrupted, like `/ws`. */
const HeldWebSocketRoute = HttpRouter.add(
  "GET",
  "/ws",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const socket = yield* request.upgrade;
    yield* socket.runRaw(() => {});
    return HttpServerResponse.empty();
  }).pipe(Effect.orDie),
);

/** A plain request that never answers, like a long thread-tool callback. */
const HeldRequestRoute = HttpRouter.add("GET", "/held", Effect.never);

const upgradeRequest = [
  "GET /ws HTTP/1.1",
  "Host: localhost",
  "Connection: Upgrade",
  "Upgrade: websocket",
  "Sec-WebSocket-Version: 13",
  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
  "",
  "",
].join("\r\n");
const heldRequest = "GET /held HTTP/1.1\r\nHost: localhost\r\n\r\n";

/** Writes `request` and resolves once the first response bytes arrive (or the socket is open). */
function openClient(path: string, request: string, awaitResponse: boolean) {
  return new Promise<{ readonly socket: Socket; readonly closed: Promise<void> }>(
    (resolve, reject) => {
      const socket = connect(path);
      const closed = new Promise<void>((done) => socket.once("close", () => done()));
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(request);
        if (!awaitResponse) setTimeout(() => resolve({ socket, closed }), 100);
      });
      if (awaitResponse)
        socket.once("data", (chunk) => {
          expect(String(chunk)).toMatch(/^HTTP\/1\.1 101 /);
          resolve({ socket, closed });
        });
    },
  );
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Serves one route on the production Unix listener, opens a client, then times the close. */
async function timeListenerClose(
  route: typeof HeldRequestRoute,
  request: string,
  upgrade: boolean,
) {
  const root = await mkdtemp(join(tmpdir(), "bb-http-"));
  roots.push(root);
  const path = join(root, "s.sock");
  const scope = Effect.runSync(Scope.make());
  await Effect.runPromise(
    Layer.buildWithScope(
      serveIsolatedRemoteRoutes(route).pipe(Layer.provide(remoteUnixHttpServerLive(path))),
      scope,
    ),
  );
  const client = await openClient(path, request, upgrade);
  const started = performance.now();
  // An interrupted held handler surfaces as an interrupt-only close exit, which a stop allows.
  const closed = await Effect.runPromiseExit(Scope.close(scope, Exit.void));
  const elapsedMs = performance.now() - started;
  if (Exit.isFailure(closed)) expect(Cause.hasInterruptsOnly(closed.cause)).toBe(true);
  // The server ended an upgraded socket itself; a plain request's socket dies with the process.
  if (upgrade) await client.closed;
  else client.socket.destroy();
  return elapsedMs;
}

describe("production Node HTTP listener shutdown", () => {
  it("closes promptly while a WebSocket client stays connected", async () => {
    // Before the fix, `server.close()` waited for the upgraded socket for the whole grace period
    // (20 s by default), so a backend stop with a connected client outlived `TimeoutStopSec`.
    const elapsedMs = await timeListenerClose(HeldWebSocketRoute, upgradeRequest, true);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("bounds an in-flight plain request by the short grace period", async () => {
    const elapsedMs = await timeListenerClose(HeldRequestRoute, heldRequest, false);
    expect(elapsedMs).toBeGreaterThanOrEqual(HTTP_GRACEFUL_SHUTDOWN_MS - 100);
    expect(elapsedMs).toBeLessThan(HTTP_GRACEFUL_SHUTDOWN_MS + 2_000);
  });
});
