import { Effect, Layer, ServiceMap } from "effect";

import { BackendInstance } from "../startup/backendInstance.ts";
import { loadRemoteBackendIdentity, type RemoteBackendIdentity } from "./authority.ts";
import { RemoteBackendAuthorityError } from "./authority.record.ts";

export class RemoteBackendIdentityService extends ServiceMap.Service<
  RemoteBackendIdentityService,
  RemoteBackendIdentity
>()("bigbud/remote-backend/Identity") {}

export const makeRemoteBackendIdentityLive = (
  options: { readonly requireExisting?: boolean } = {},
) => {
  const requireExisting = options.requireExisting === true;
  return Layer.effect(
    RemoteBackendIdentityService,
    Effect.gen(function* () {
      const owner = yield* BackendInstance;
      return yield* Effect.tryPromise({
        try: () => loadRemoteBackendIdentity(owner, { requireExisting }),
        catch: (cause) =>
          cause instanceof RemoteBackendAuthorityError
            ? cause
            : new RemoteBackendAuthorityError(
                "unsafe-state",
                "The remote identity could not be loaded.",
              ),
      });
    }),
  );
};

export const RemoteBackendIdentityLive = makeRemoteBackendIdentityLive();
