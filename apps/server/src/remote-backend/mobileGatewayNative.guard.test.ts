import * as fs from "node:fs/promises";
import "../remote-agent/mobileGatewayLifecycle.native.test-boundaries.ts";
import * as Effect from "effect/Effect";
import { join } from "node:path";
import { beforeAll, afterAll, afterEach, expect, it } from "vitest";
import { BackendInstance } from "../startup/backendInstance.ts";
import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import { publicationFixture } from "../remote-agent/mobileOptionalPublication.test-fixtures.ts";
import {
  nativeOwnershipFixture,
  buildNativeOwnershipFixturePeer,
} from "../remote-agent/mobileGatewayLifecycle.native.fixture.ts";
import {
  gatewayConfiguration,
  gatewayFixtureOwnerStore,
} from "../remote-agent/mobileGatewayLifecycle.test-fixtures.ts";
import type { NativeLeaseGuardV2 } from "../remote-agent/remoteAgentServiceLease.guard.ts";
import { mobileGatewayBuildPin } from "../remote-agent/mobileGatewayLifecycle.transitions.ts";
import { makeNativeMobileGatewayGuard } from "./mobileGatewayNative.guard.ts";

let peer = "";
let closePeer: (() => Promise<void>) | undefined;
const fixtures: Awaited<ReturnType<typeof publicationFixture>>[] = [];
beforeAll(async () => {
  const built = await buildNativeOwnershipFixturePeer();
  peer = built.peer;
  closePeer = built.close;
});
afterAll(async () => {
  await closePeer?.();
});
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await publicationFixture({ ownerStartedAt: "start-v2:linux:fixture-boot:123" });
  fixtures.push(f);
  return f;
}
it("derives fixed private anchors and all32 original predicates without self-referential hashes", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      n = await nativeOwnershipFixture(f, proof, peer);
    try {
      // This unit uses a memory CAS; materialize only its private canonical parent for anchors.
      await fs.mkdir(join(f.control.root, "control-v1"), { recursive: true, mode: 0o700 });
      const input = { ...gatewayConfiguration };
      const build = await Effect.runPromise(
        makeNativeMobileGatewayGuard(proof, input).pipe(
          Effect.provideService(BackendInstance, f.owner()),
          Effect.provideService(RemoteAgentRuntimeOwners, gatewayFixtureOwnerStore(f)),
        ),
      );
      input.externalOrigin = "https://mutated.example";
      const bytes = await build(n.assets, n.client, n.attempt);
      const spec: NativeLeaseGuardV2 = JSON.parse(Buffer.from(bytes).toString("utf8"));
      expect(spec.version).toBe(2);
      expect(spec.file).toBe(join(f.control.root, "control-v1", "registry.json"));
      expect(spec.anchors.map((a) => a.path)).toEqual([
        f.control.root,
        join(f.control.root, "control-v1"),
        f.stateDir,
      ]);
      expect(
        spec.all.length + spec.select.reduce((sum, selected) => sum + selected.all.length, 0),
      ).toBe(32);
      expect(spec.select[0]).toMatchObject({
        key: "nonce",
        value: n.client.binding(n.pending).nonce,
        maxRows: 32,
      });
      expect(spec.select[1]).toMatchObject({
        path: ["pins"],
        key: "owner",
        value: mobileGatewayBuildPin(n.client.binding(n.pending).nonce),
        maxRows: 128,
      });
      const expected = spec.select[0]!.all;
      expect(expected.filter((p) => "valueFrom" in p)).toEqual([
        {
          path: ["nativeOwnership", "binding", "configurationSha256"],
          valueFrom: "configurationSha256",
        },
        { path: ["nativeOwnership", "binding", "guardSha256"], valueFrom: "guardSha256" },
      ]);
      expect(expected).toContainEqual({
        path: ["configuration", "externalOrigin"],
        values: [gatewayConfiguration.externalOrigin],
      });
      expect(expected).toContainEqual({
        path: ["nativeOwnership", "assetsReference", "sha256"],
        values: [n.reference.sha256],
      });
      expect(spec.all).toContainEqual({ path: ["mobile", "consent", "enabled"], values: [true] });
      expect(bytes.length).toBeLessThanOrEqual(16384);
      await expect(build(n.assets, { ...n.client }, n.attempt)).rejects.toThrow(
        /Original authenticated/,
      );
      await n.api.reserve(n.assets, n.client, n.pending);
      await expect(build(n.assets, n.client, n.attempt)).rejects.toThrow(/unarmed assets/);
    } finally {
      await n.close();
    }
  });
});
