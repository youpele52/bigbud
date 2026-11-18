import * as fs from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "./startup/config.ts";
import { BackendInstance, makeBackendInstance } from "./startup/backendInstance.ts";
import { acquireStateDirLock } from "./startup/stateDirLock.ts";
import { loadRemoteBackendIdentity } from "./remote-backend/authority.ts";
import {
  bindAccountServiceIdentity,
  RemoteBackendIdentityForServerLive,
} from "./remote-backend/identity.service.policy.ts";

export async function callbackFixture(port = 0) {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/bb-callback-"));
  const original = await Effect.runPromise(
    Effect.scoped(
      Effect.service(ServerConfig).pipe(
        Effect.provide(ServerConfig.layerTest(root, root).pipe(Layer.provide(NodeServices.layer))),
      ),
    ),
  );
  await fs.chmod(original.stateDir, 0o700);
  const config = { ...original, mode: "remote" as const, host: "127.0.0.1", port };
  const handle = await acquireStateDirLock({ stateDir: config.stateDir, port });
  const owner = makeBackendInstance(handle, config.stateDir);
  const identity = await loadRemoteBackendIdentity(owner);
  bindAccountServiceIdentity(config, identity);
  const dependencies = Layer.mergeAll(
    Layer.succeed(ServerConfig, config),
    Layer.succeed(BackendInstance, owner),
  );
  return {
    config,
    owner,
    handle,
    identity,
    dependencies,
    identityLayer: RemoteBackendIdentityForServerLive.pipe(Layer.provideMerge(dependencies)),
    async close() {
      await handle.release();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
