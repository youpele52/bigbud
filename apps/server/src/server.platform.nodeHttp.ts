/**
 * The one Node HTTP server shape behind every production listener (TCP, remote client/mobile/peer
 * Unix sockets and the loopback callback listener).
 *
 * Shutdown (O-2): `NodeHttpServer`'s serve finalizer calls `server.close()` and waits for it
 * (bounded by `gracefulShutdownTimeout`) before it interrupts the request fibers. Node's `close()`
 * resolves only once every accepted connection has ended, and it ends idle HTTP connections
 * itself, but an upgraded (WebSocket) socket is detached from HTTP connection tracking and is
 * never ended. Its handler fiber is the one that would close it, and that fiber is interrupted
 * only after the wait. So one connected client held every stop for the full grace period
 * (Effect's default 20 s, beyond systemd's `TimeoutStopSec=15`).
 *
 * `close()` therefore also destroys the upgraded sockets, which clients already treat as a dropped
 * connection and reconnect from, and the grace for ordinary in-flight requests stays short.
 */
import * as Http from "node:http";
import type { Duplex } from "node:stream";
import * as Duration from "effect/Duration";

/** Bound for in-flight plain HTTP requests (handshakes, callbacks) once a listener closes. */
export const HTTP_GRACEFUL_SHUTDOWN_MS = 3_000;

/** `http.createServer()` whose `close()` also ends upgraded (WebSocket) connections. */
export function createShutdownAwareHttpServer(): Http.Server {
  const server = Http.createServer();
  const upgraded = new Set<Duplex>();
  // Runs before the WebSocket handler takes the socket; a socket closed early is never tracked.
  server.prependListener("upgrade", (_request, socket: Duplex) => {
    if (socket.destroyed) return;
    upgraded.add(socket);
    socket.once("close", () => upgraded.delete(socket));
  });
  const close = server.close.bind(server);
  server.close = (callback?: (error?: Error) => void) => {
    close(callback);
    for (const socket of upgraded) socket.destroy();
    upgraded.clear();
    return server;
  };
  return server;
}

/** `NodeHttpServer.layer` options shared by every listener. */
export const nodeHttpServerShutdownOptions = {
  gracefulShutdownTimeout: Duration.millis(HTTP_GRACEFUL_SHUTDOWN_MS),
} as const;
