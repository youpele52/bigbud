/** Real private HTTP/Rust child proof; TEST route/P4 peer and throwing unused RPC services only. */
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RemoteBackendMobileDescriptor } from "@bigbud/contracts/server/remoteBackendHandshake";
import { compareRemoteBackendIdentity } from "@bigbud/shared/remoteBackendIdentity";
import { ownerIntegrationArtifacts } from "./mobileGatewayOwner.integration.artifacts.ts";
import { createOwnerIntegrationFixture } from "./mobileGatewayOwner.integration.fixture.ts";
import { unrelatedGatewayServices } from "./mobileOwnerPairing.boundaryServices.ts";
import { RemoteMobileGatewayOwnerLive } from "./mobileGatewayOwner.ts";
import { RemoteMobileGatewayOwner } from "./mobileGatewayOwner.service.ts";
import { RemoteMobileGatewayRouteOwner } from "./mobileGatewayOwner.route.ts";
import { RemoteMobileGatewayStatus } from "./mobileGatewayStatus.ts";
import { RemoteMobileControlFacadeLive } from "./mobileControlFacade.ts";
import { ServerConfig } from "../startup/config.ts";
import { BootstrapCommandLockLive } from "../ws/wsBootstrap.lock.ts";
import { withMobileOptionalPublisher } from "../remote-agent/mobileOptionalPublication.ts";
import {
  runMobileGatewayListener,
  type MobileGatewayListenerServices,
} from "./mobileGatewayListener.ts";

const request = (options: http.RequestOptions) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ ...options, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16384) req.destroy(new Error("Fixture response exceeded budget"));
        else chunks.push(chunk);
      });
      response.once("end", () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
      response.once("error", reject);
    });
    req.once("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("Fixture HTTP deadline")));
    req.end();
  });
async function until(predicate: () => boolean, label: string) {
  const deadline = performance.now() + 15000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Listener fixture timed out: ${label}`);
    await delay(10);
  }
}
export async function runListenerIntegration() {
  const artifacts = await ownerIntegrationArtifacts();
  const f = await createOwnerIntegrationFixture(artifacts, { privateTransport: false });
  const path = join(f.owner.stateDir, "remote-mobile.sock");
  const origin = "https://listener-fixture.ts.net";
  let routeCalls = 0;
  const routeOwner = Layer.succeed(RemoteMobileGatewayRouteOwner, {
    async withRoute(input, operation, signal) {
      assert.equal(input.externalOrigin, origin);
      assert.deepEqual(input.expected.authority, f.identity.authority);
      routeCalls++;
      return operation(
        {
          assertCurrent: async (current) => {
            current.throwIfAborted();
            signal.throwIfAborted();
          },
        },
        signal,
      );
    },
  });
  const ownerLayer = RemoteMobileGatewayOwnerLive.pipe(Layer.provide(routeOwner));
  const actual = Layer.mergeAll(f.runtimeLayer, ownerLayer);
  const facade = RemoteMobileControlFacadeLive.pipe(Layer.provide(actual));
  const dependencies = Layer.mergeAll(
    unrelatedGatewayServices,
    actual,
    facade,
    BootstrapCommandLockLive,
  ).pipe(Layer.provideMerge(NodeServices.layer));
  let held: ReturnType<typeof f.holdBindingReads> | undefined;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Effect.services<MobileGatewayListenerServices>();
          const owner = yield* RemoteMobileGatewayOwner,
            status = yield* RemoteMobileGatewayStatus;
          const base = yield* ServerConfig;
          assert.equal(base.remoteMobile, undefined);
          assert.equal(yield* status.ready, false);
          yield* Effect.promise(() => assert.rejects(fs.lstat(path), { code: "ENOENT" }));
          yield* f.settings.updateSettings({ mobileRemoteControl: { enabled: true } });
          yield* withMobileOptionalPublisher(artifacts.keys, async (publisher) => {
            const proof = await publisher.publish({
              ...artifacts.request,
              stageId: "listener-real",
            });
            let settled = false;
            const running = Effect.runPromise(
              runMobileGatewayListener(proof, {
                nonce: "listener-real-one",
                externalOrigin: origin,
                port: 49323,
              }).pipe(Effect.provideServices(services)),
            )
              .then(
                () => ({ ok: true as const }),
                (error) => ({ ok: false as const, error }),
              )
              .finally(() => {
                settled = true;
              });
            try {
              await until(
                () => owner.getPhase() === "running" || settled,
                "real HTTP and gateway active",
              );
              if (settled) {
                const result = await running;
                if (!result.ok) throw result.error;
              }
              assert.equal(owner.getPhase(), "running");
              assert.equal(routeCalls, 1);
              const socket = await fs.lstat(path);
              assert.equal(socket.mode & 0o7777, 0o600);
              assert.equal(
                (await request({ socketPath: path, path: "/api/mobile/handshake" })).status,
                403,
              );
              const remote = await request({
                hostname: "127.0.0.1",
                port: 49323,
                path: "/api/mobile/handshake",
                headers: { host: new URL(origin).host, origin },
              });
              assert.equal(remote.status, 200);
              const descriptor = Schema.decodeUnknownSync(RemoteBackendMobileDescriptor)(
                JSON.parse(remote.body),
                { onExcessProperty: "error" },
              );
              assert.equal(compareRemoteBackendIdentity(descriptor, f.identity), "match");
              assert.equal(descriptor.mobileCapable, true);
              assert.equal(
                (
                  await request({
                    socketPath: path,
                    path: "/api/mobile/handshake",
                    headers: { "x-bigbud-mobile-gateway": "wrong-fixture-credential" },
                  })
                ).status,
                403,
              );
              assert.equal(
                base.remoteMobile,
                undefined,
                "fresh private credential must not mutate global runtime config",
              );
              held = f.holdBindingReads();
              const oldRead = Effect.runPromise(status.readAdmission!());
              await held.began;
              await delay(30);
              await f.consent(false);
              await Effect.runPromise(
                f.settings.updateSettings({ mobileRemoteControl: { enabled: false } }),
              );
              assert.equal(owner.getPhase(), "revoking");
              assert.equal(settled, false);
              assert.equal(await Effect.runPromise(status.readAdmission!()), null);
              assert.equal(
                (await fs.lstat(path)).ino,
                socket.ino,
                "HTTP endpoint must remain until real child cleanup settles",
              );
              assert.equal(
                (await request({ socketPath: path, path: "/api/mobile/handshake" })).status,
                403,
              );
              held.release();
              held = undefined;
              assert.equal(await oldRead, null);
              await running;
              assert.equal(owner.getPhase(), "idle");
              await assert.rejects(fs.lstat(path), { code: "ENOENT" });
              const final = await f.store.read();
              if (final.schemaVersion !== 3) throw new Error("Missing fixture journal");
              assert.equal(final.mobile.gatewayLifecycle!.attempts[0]!.phase, "exit-confirmed");
              assert.equal(
                final.pins.filter((pin) => pin.owner.startsWith("mobile-gateway:")).length,
                0,
              );
              console.log(
                JSON.stringify({
                  realRustChild: true,
                  realMobileHttpRoutes: true,
                  testP4WirePeer: true,
                  testRouteObserver: true,
                  privateMissingCredential403: true,
                  wrongCredential403: true,
                  observedIdentityMatch: true,
                  dynamicConfigRemainsPrivate: true,
                  cleanupBeforeHttpRelease: true,
                  exactSocketRemoved: true,
                }),
              );
            } finally {
              held?.release();
              held = undefined;
              await f.consent(false).catch(() => {});
              await Effect.runPromise(
                f.settings.updateSettings({ mobileRemoteControl: { enabled: false } }),
              );
              await running;
            }
          });
        }).pipe(Effect.provide(dependencies)),
      ),
    );
  } finally {
    held?.release();
    await f.close();
  }
}
if (import.meta.main) await runListenerIntegration();
