import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { RemoteBackendAuthorityError } from "./remote-backend/authority.record.ts";
import { RemoteBackendIdentityService } from "./remote-backend/identity.service.ts";
import { RemoteCallbackHttpServerLive } from "./server.platform.ts";
import { BackendInstance } from "./startup/backendInstance.ts";
import { ServerConfig, type ServerConfigShape } from "./startup/config.ts";

export class RemoteCallbackBinding extends ServiceMap.Service<
  RemoteCallbackBinding,
  {
    readonly config: ServerConfigShape;
    readonly httpServices: ServiceMap.ServiceMap<
      Layer.Success<typeof RemoteCallbackHttpServerLive>
    >;
  }
>()("bigbud/server/RemoteCallbackBinding") {}

/** The original identity policy must run against the original config before this copy exists. */
export const RemoteCallbackBindingLive = Layer.effect(
  RemoteCallbackBinding,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const owner = yield* BackendInstance;
    yield* RemoteBackendIdentityService;
    const assertHeld = Effect.tryPromise({
      try: owner.assertHeld,
      catch: () =>
        new RemoteBackendAuthorityError("owner-changed", "The callback listener lost its owner."),
    });
    yield* assertHeld;
    const httpServices = yield* Layer.build(RemoteCallbackHttpServerLive);
    yield* assertHeld;
    const { address } = ServiceMap.get(httpServices, HttpServer.HttpServer);
    if (address._tag !== "TcpAddress" || address.port < 1 || address.hostname !== "127.0.0.1")
      return yield* Effect.fail(
        new RemoteBackendAuthorityError("unsafe-state", "The callback listener is not loopback."),
      );
    return {
      config: Object.freeze({ ...config, host: "127.0.0.1", port: address.port }),
      httpServices,
    };
  }),
);

/** One runtime graph observes the already-bound port; serving reuses the original server. */
export function withRemoteCallbackRuntime<A, E, R, B, E2, R2>(
  application: Layer.Layer<A, E, R>,
  runtime: Layer.Layer<B, E2, R2>,
) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const binding = yield* RemoteCallbackBinding;
      return application.pipe(
        Layer.provideMerge(runtime),
        Layer.provide(Layer.succeed(ServerConfig, binding.config)),
      );
    }),
  );
}
