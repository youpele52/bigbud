/** Standalone bounded Linux proof: actual Rust child; explicitly TEST route and P4 wire peers. */
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { setTimeout as delay } from "node:timers/promises";
import { withMobileOptionalPublisher } from "../remote-agent/mobileOptionalPublication.ts";
import { RemoteMobileGatewayOwnerLive } from "./mobileGatewayOwner.ts";
import { RemoteMobileGatewayOwner } from "./mobileGatewayOwner.service.ts";
import { RemoteMobileGatewayStatus } from "./mobileGatewayStatus.ts";
import { RemoteMobileGatewayRouteOwner } from "./mobileGatewayOwner.route.ts";
import { ownerIntegrationArtifacts } from "./mobileGatewayOwner.integration.artifacts.ts";
import { createOwnerIntegrationFixture } from "./mobileGatewayOwner.integration.fixture.ts";

async function until(predicate: () => boolean, label: string) {
  const deadline = performance.now() + 15_000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Owner fixture timed out: ${label}`);
    await delay(10);
  }
}
export async function runOwnerIntegration() {
  const artifacts = await ownerIntegrationArtifacts();
  const f = await createOwnerIntegrationFixture(artifacts);
  let routeCalls = 0,
    allowRoute!: () => void;
  let endRoute: (() => void) | undefined;
  let gate = new Promise<void>((resolve) => {
    allowRoute = resolve;
  });
  const routeOwner = Layer.succeed(RemoteMobileGatewayRouteOwner, {
    async withRoute(input, operation, external) {
      assert.equal(input.externalOrigin, "https://owner-fixture.ts.net");
      assert.deepEqual(input.expected.authority, f.identity.authority);
      routeCalls++;
      await gate;
      external.throwIfAborted();
      const controller = new AbortController();
      endRoute = () => controller.abort();
      const signal = AbortSignal.any([external, controller.signal]);
      try {
        return await operation(
          {
            assertCurrent: async (current) => {
              current.throwIfAborted();
              signal.throwIfAborted();
            },
          },
          signal,
        );
      } finally {
        controller.abort();
        endRoute = undefined;
      }
    },
  });
  const { owner, status } = await Effect.runPromise(
    Effect.gen(function* () {
      return { owner: yield* RemoteMobileGatewayOwner, status: yield* RemoteMobileGatewayStatus };
    }).pipe(Effect.provide(RemoteMobileGatewayOwnerLive.pipe(Layer.provide(routeOwner)))),
  );
  let held: ReturnType<typeof f.holdBindingReads> | undefined;
  const trace: Record<string, unknown> = {
    realRustGateway: true,
    testP4WirePeer: true,
    testRouteObserver: true,
  };
  try {
    assert.equal(owner.getPhase(), "idle");
    assert.equal(await Effect.runPromise(status.ready), false);
    assert.equal(await Effect.runPromise(status.readAdmission!()), null);
    assert.equal(routeCalls, 0);
    await Effect.runPromise(f.settings.updateSettings({ mobileRemoteControl: { enabled: true } }));
    await Effect.runPromise(
      withMobileOptionalPublisher(artifacts.keys, async (publisher) => {
        const proof = await publisher.publish(artifacts.request);
        let runSettled = false;
        const run = Effect.runPromise(
          owner
            .run(proof, {
              nonce: "owner-real-one",
              externalOrigin: "https://owner-fixture.ts.net",
              port: 49322,
            })
            .pipe(Effect.provide(f.runtimeLayer)),
        )
          .then(
            () => ({ ok: true as const }),
            (error) => ({ ok: false as const, error }),
          )
          .finally(() => {
            runSettled = true;
          });
        try {
          await until(
            () => routeCalls === 1 || runSettled,
            "actual process reached route callback",
          );
          if (runSettled) {
            const result = await run;
            if (!result.ok) throw result.error;
          }
          assert.ok(f.requests() > 0, "real Rust child must have probed the sealed credential UDS");
          assert.equal(owner.getPhase(), "starting");
          assert.equal(await Effect.runPromise(status.ready), false);
          allowRoute();
          await until(() => owner.getPhase() === "running", "route and process admitted");
          const first = await Effect.runPromise(status.readAdmission!());
          assert.ok(first);
          assert.equal(first.consentRevision, 1);
          trace.firstRevision = first.consentRevision;
          const state = await f.store.read();
          assert.equal(state.schemaVersion, 3);
          if (state.schemaVersion !== 3) throw new Error("Missing real fixture registry");
          assert.equal(state.mobile.gatewayLifecycle?.attempts.length, 1);
          assert.equal(state.mobile.gatewayLifecycle.attempts[0]!.phase, "child-owned");
          assert.ok(
            state.mobile.gatewayLifecycle.attempts[0]!.child?.startedAt.startsWith(
              "start-v2:linux:",
            ),
          );
          const childPid = state.mobile.gatewayLifecycle.attempts[0]!.child!.pid;
          const watch = Effect.runPromise(status.watchAdmissionEnd!(first));
          held = f.holdBindingReads();
          let oldReadSettled = false;
          const oldRead = Effect.runPromise(status.readAdmission!()).finally(() => {
            oldReadSettled = true;
          });
          await held.began;
          await delay(30);
          assert.equal(oldReadSettled, false);
          await f.consent(false); // Real durable CAS precedes the settings-off event in this fixture.
          await Effect.runPromise(
            f.settings.updateSettings({ mobileRemoteControl: { enabled: false } }),
          );
          assert.equal(owner.getPhase(), "revoking");
          assert.equal(await Effect.runPromise(status.ready), false);
          assert.equal(await Effect.runPromise(status.readAdmission!()), null);
          assert.equal(
            await Promise.race([watch, delay(2000).then(() => "watch-timeout")]),
            "disabled",
          );
          assert.equal(runSettled, false, "accepted held read must settle before cleanup/idle");
          process.kill(childPid, 0); // Observe only; never adopt or signal a persisted PID.
          trace.deniedWhileCleanupHeld = true;
          held.release();
          held = undefined;
          assert.equal(await oldRead, null, "held old admission cannot escape after revoke");
          await run;
          assert.equal(owner.getPhase(), "idle");
          const stopped = await f.store.read();
          if (stopped.schemaVersion !== 3) throw new Error("Missing stopped registry");
          assert.equal(stopped.mobile.gatewayLifecycle!.attempts[0]!.phase, "exit-confirmed");
          assert.equal(
            stopped.pins.filter((pin) => pin.owner.startsWith("mobile-gateway:")).length,
            0,
          );
          await delay(1200);
          const unchanged = await f.store.read();
          assert.equal(
            unchanged.schemaVersion === 3 && unchanged.mobile.gatewayLifecycle?.attempts.length,
            1,
          );
          trace.noAutomaticRespawn = true;
          trace.oldReadDenied = true;
        } finally {
          held?.release();
          held = undefined;
          endRoute?.();
          allowRoute();
          await run;
        }
      }).pipe(Effect.provide(f.runtimeLayer)),
    );
    const next = await f.consent(true);
    if (next.schemaVersion !== 3) throw new Error("Missing new consent revision");
    await Effect.runPromise(f.settings.updateSettings({ mobileRemoteControl: { enabled: true } }));
    gate = Promise.resolve();
    await Effect.runPromise(
      withMobileOptionalPublisher(artifacts.keys, async (publisher) => {
        const proof = await publisher.publish({
          ...artifacts.request,
          stageId: "owner-integration-two",
          consentRevision: next.mobile.consent.revision,
        });
        const run = Effect.runPromise(
          owner
            .run(proof, {
              nonce: "owner-real-two",
              externalOrigin: "https://owner-fixture.ts.net",
              port: 49322,
            })
            .pipe(Effect.provide(f.runtimeLayer)),
        ).then(
          () => undefined,
          () => undefined,
        );
        try {
          await until(() => owner.getPhase() === "running", "fresh revision admitted");
          const fresh = await Effect.runPromise(status.readAdmission!());
          assert.ok(fresh);
          assert.equal(fresh.consentRevision, next.mobile.consent.revision);
          assert.ok(fresh.consentRevision > 1);
          trace.newRevision = fresh.consentRevision;
          endRoute?.();
          await run;
          assert.equal(owner.getPhase(), "idle");
        } finally {
          endRoute?.();
          await run;
        }
      }).pipe(Effect.provide(f.runtimeLayer)),
    );
    const final = await f.store.read();
    assert.equal(final.schemaVersion === 3 && final.mobile.gatewayLifecycle?.attempts.length, 2);
    trace.actualAttempts = 2;
    trace.privateHandshakeRequests = f.requests();
    console.log(JSON.stringify(trace));
  } finally {
    held?.release();
    endRoute?.();
    allowRoute();
    await f.close();
  }
}

if (import.meta.main) await runOwnerIntegration();
