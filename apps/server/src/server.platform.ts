import { Effect, Layer } from "effect";

import { ServerConfig } from "./startup/config.ts";

function tcpHttpServerLive(port: number, host: string | undefined) {
  return Layer.unwrap(
    Effect.gen(function* () {
      if (typeof Bun !== "undefined") {
        const BunHttpServer = yield* Effect.promise(
          () => import("@effect/platform-bun/BunHttpServer"),
        );
        return BunHttpServer.layer({
          port,
          ...(host ? { hostname: host } : {}),
        });
      }
      const [NodeHttpServer, NodeHttp] = yield* Effect.all([
        Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
        Effect.promise(() => import("./server.platform.nodeHttp.ts")),
      ]);
      return NodeHttpServer.layer(NodeHttp.createShutdownAwareHttpServer, {
        host,
        port,
        ...NodeHttp.nodeHttpServerShutdownOptions,
      });
    }),
  );
}

export const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return tcpHttpServerLive(config.port, config.host);
  }),
);

/** Intrinsic binding policy: even direct composition callers cannot expose callbacks publicly. */
export const RemoteCallbackHttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return tcpHttpServerLive(config.port, "127.0.0.1");
  }),
);

export function remoteUnixHttpServerLive(path: string) {
  return Layer.unwrap(
    Effect.gen(function* () {
      if (typeof Bun !== "undefined") {
        const BunHttpServer = yield* Effect.promise(
          () => import("@effect/platform-bun/BunHttpServer"),
        );
        return BunHttpServer.layer({ unix: path });
      }
      const [NodeHttpServer, NodeHttp] = yield* Effect.all([
        Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
        Effect.promise(() => import("./server.platform.nodeHttp.ts")),
      ]);
      return NodeHttpServer.layer(NodeHttp.createShutdownAwareHttpServer, {
        path,
        ...NodeHttp.nodeHttpServerShutdownOptions,
      });
    }),
  );
}

export const PlatformServicesLive = Layer.unwrap(
  Effect.gen(function* () {
    if (typeof Bun !== "undefined") {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-bun/BunServices"));
      return layer;
    }
    const { layer } = yield* Effect.promise(() => import("@effect/platform-node/NodeServices"));
    return layer;
  }),
);
