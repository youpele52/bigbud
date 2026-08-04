import { Effect, Layer } from "effect";

import { ServerConfig } from "./startup/config.ts";

export const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (typeof Bun !== "undefined") {
      const BunHttpServer = yield* Effect.promise(
        () => import("@effect/platform-bun/BunHttpServer"),
      );
      return BunHttpServer.layer({
        port: config.port,
        ...(config.host ? { hostname: config.host } : {}),
      });
    }
    const [NodeHttpServer, NodeHttp] = yield* Effect.all([
      Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
      Effect.promise(() => import("node:http")),
    ]);
    return NodeHttpServer.layer(NodeHttp.createServer, {
      host: config.host,
      port: config.port,
    });
  }),
);

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
