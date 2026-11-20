import { generateKeyPairSync } from "node:crypto";
import { Effect, Layer, Schema } from "effect";
import { RemoteBackendClientHandshake } from "@bigbud/contracts/server/remoteBackendClientHandshake.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpRouter } from "effect/unstable/http";
import { expect, it } from "vitest";

import { ServerConfig } from "../startup/config.ts";
import { makeRemoteClientHandshakeRoute } from "./clientRoutes.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import {
  RemoteRuntimeUpdate,
  type RemoteRuntimeUpdateShape,
} from "./Services/RemoteRuntimeUpdate.ts";

const { publicKey } = generateKeyPairSync("ed25519");
const identity = Layer.succeed(RemoteBackendIdentityService, {
  authority: {
    authorityId: "a".repeat(32),
    keyEpoch: 1,
    keyFingerprint: `sha256:${"b".repeat(64)}`,
  },
  installationFingerprint: `sha256:${"c".repeat(64)}`,
  publicKey,
  signChallenge: () => {
    throw new Error("Handshake must not expose a signer.");
  },
});
const config = Layer.effect(
  ServerConfig,
  Effect.gen(function* () {
    return { ...(yield* ServerConfig), mode: "remote" as const, authToken: "fixture-secret" };
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest("/tmp/handshake-fixture", "/tmp/handshake-fixture").pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

async function handshake(withUpdates: boolean) {
  const services = withUpdates
    ? Layer.merge(identity, Layer.succeed(RemoteRuntimeUpdate, {} as RemoteRuntimeUpdateShape))
    : identity;
  const app = HttpRouter.toWebHandler(
    makeRemoteClientHandshakeRoute("1.0.0").pipe(
      HttpRouter.provideRequest(services),
      Layer.provide(config),
    ),
    { disableLogger: true },
  );
  try {
    const response = await app.handler(
      new Request("http://remote.invalid/api/remote-backend/handshake", {
        headers: { authorization: "Bearer fixture-secret" },
      }),
    );
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(RemoteBackendClientHandshake)(await response.json());
  } finally {
    await app.dispose();
  }
}

it("handshake_reports_runtime_updates_only_when_the_remote_service_is_composed", async () => {
  expect((await handshake(true)).capabilities.runtimeUpdates).toBe(true);
  expect((await handshake(false)).capabilities.runtimeUpdates).toBe(false);
});
