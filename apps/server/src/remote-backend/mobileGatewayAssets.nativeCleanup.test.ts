import "../remote-agent/mobileGatewayLifecycle.native.test-boundaries.ts";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { beforeAll, afterAll, afterEach, expect, it } from "vitest";
import { publicationFixture } from "../remote-agent/mobileOptionalPublication.test-fixtures.ts";
import {
  nativeOwnershipFixture,
  buildNativeOwnershipFixturePeer,
} from "../remote-agent/mobileGatewayLifecycle.native.fixture.ts";
import { setRemoteAgentMobileConsent } from "../remote-agent/remoteAgentInstall.mobile.transitions.ts";
import { mobileGatewayBuildPin } from "../remote-agent/mobileGatewayLifecycle.transitions.ts";
import { pinRemoteAgentBuild } from "../remote-agent/remoteAgentInstall.registry.transitions.ts";
import { makeRemoteAgentRegistryStore } from "../remote-agent/remoteAgentInstall.registry.store.ts";
import {
  confirmNativeMobileGatewayAssetsExit,
  confirmNativeMobileGatewayAssetsCancellation,
} from "./mobileGatewayAssets.nativeCleanup.ts";
import {
  mobileGatewayAssetsPath,
  armMobileGatewayAssetsTransfer,
  removeMobileGatewayAssets,
} from "./mobileGatewayProcess.assets.ts";

// The actual owner client uses an explicit comparable Linux controller in this controlled pipe test.
let peer = "";
let closePeer: (() => Promise<void>) | undefined;
const fixtures: Awaited<ReturnType<typeof publicationFixture>>[] = [];
beforeAll(async () => {
  const built = await buildNativeOwnershipFixturePeer();
  peer = built.peer;
  closePeer = built.close;
});
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
afterAll(async () => {
  await closePeer?.();
});
async function fixture() {
  const f = await publicationFixture({ ownerStartedAt: "start-v2:linux:fixture-boot:123" });
  fixtures.push(f);
  return f;
}
it("requires original exit plus terminal same-CAS, works after revocation and preserves unrelated pins", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      n = await nativeOwnershipFixture(f, proof, peer);
    try {
      const intent = await n.api.reserve(n.assets, n.client, n.pending);
      expect(intent).not.toBeNull();
      await n.api.markInvoked(intent!);
      await expect(n.api.markInvoked(intent!)).rejects.toThrow(/unspent/);
      const lease = await n.client.start(n.pending);
      expect(() => Reflect.apply(n.client.exitEvidence, n.client, [lease])).toThrow(
        /confirmed native exit/,
      );
      await expect(removeMobileGatewayAssets(proof, n.assets)).rejects.toThrow(/Native transfer/);
      const store = makeRemoteAgentRegistryStore(f.control.root, f.command());
      await store.update((s) =>
        pinRemoteAgentBuild(s, "unrelated-client", n.context.binding.buildId),
      );
      await Effect.runPromise(
        f.settings.updateSettings({ mobileRemoteControl: { enabled: false } }),
      );
      await store.update((s) =>
        setRemoteAgentMobileConsent(s, { owner: f.pin, expectedConsentRevision: 1 }, false),
      );
      const result = await n.client.stopOriginal(n.pending);
      if (result.state !== "exited") throw Error("Controlled exit missing.");
      await expect(
        confirmNativeMobileGatewayAssetsExit(
          proof,
          n.assets,
          { ...n.client },
          n.pending,
          result.exit,
        ),
      ).rejects.toThrow(/Original authenticated/);
      await expect(
        confirmNativeMobileGatewayAssetsExit(proof, n.assets, n.client, n.pending, {
          ...result.exit,
        }),
      ).rejects.toThrow(/confirmed native exit/);
      f.command().loseNextAck();
      const cleanup = await confirmNativeMobileGatewayAssetsExit(
        proof,
        n.assets,
        n.client,
        n.pending,
        result.exit,
      );
      expect(f.read().pins).toEqual([
        { owner: "unrelated-client", buildId: n.context.binding.buildId },
      ]);
      const path = mobileGatewayAssetsPath(n.assets);
      await expect(removeMobileGatewayAssets(proof, n.assets, { ...cleanup })).rejects.toThrow(
        /cleanup capability/,
      );
      expect(await fs.readFile(join(path, "index.html"), "utf8")).toContain("fixture");
      await removeMobileGatewayAssets(proof, n.assets, cleanup);
      await expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(`${path}.receipt.json`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await n.close();
    }
  });
});
it("allows fresh never-invoked or native atomic cancellation only after exact CAS reservation", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      n = await nativeOwnershipFixture(f, proof, peer);
    try {
      f.command().loseNextAck();
      const reservation = n.api.reserve(n.assets, n.client, n.pending);
      expect(n.api.reserve(n.assets, n.client, n.pending)).toBe(reservation);
      expect(await reservation).not.toBeNull();
      const cancelled = n.client.originalNeverInvoked(n.pending);
      await expect(n.client.start(n.pending)).rejects.toThrow(/cancelled/);
      const cleanup = await confirmNativeMobileGatewayAssetsCancellation(
        proof,
        n.assets,
        n.client,
        n.pending,
        cancelled,
      );
      await removeMobileGatewayAssets(proof, n.assets, cleanup);
    } finally {
      await n.close();
    }
  });
  // A separate fresh stage/revision is not inferred; this second scope keeps original enabled consent.
  await f.run(async (publisher) => {
    const proof = await publisher.remint(f.request.stageId, f.request.consentRevision);
    const n = await nativeOwnershipFixture(f, proof, peer);
    try {
      expect(await n.api.reserve(n.assets, n.client, n.pending)).not.toBeNull();
      await n.api.markInvoked((await n.api.reserve(n.assets, n.client, n.pending))!);
      const cancelled = await n.client.cancelPending(n.pending);
      const cleanup = await confirmNativeMobileGatewayAssetsCancellation(
        proof,
        n.assets,
        n.client,
        n.pending,
        cancelled,
      );
      await removeMobileGatewayAssets(proof, n.assets, cleanup);
    } finally {
      await n.close();
    }
  });
});

it("preserves an armed tree when a genuine never-invoked proof has no canonical original CAS intent", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      n = await nativeOwnershipFixture(f, proof, peer);
    try {
      const cancellation = n.client.originalNeverInvoked(n.pending),
        path = mobileGatewayAssetsPath(n.assets);
      armMobileGatewayAssetsTransfer(n.assets);
      await expect(
        confirmNativeMobileGatewayAssetsCancellation(
          proof,
          n.assets,
          n.client,
          n.pending,
          cancellation,
        ),
      ).rejects.toThrow(/Exact original native CAS/);
      await expect(removeMobileGatewayAssets(proof, n.assets)).rejects.toThrow(/Native transfer/);
      expect(await fs.readFile(join(path, "index.html"), "utf8")).toContain("fixture");
      expect((await fs.stat(`${path}.receipt.json`)).size).toBe(n.reference.sizeBytes);
    } finally {
      await n.close();
    }
  });
});

it("preserves bytes if raw registry corruption reintroduces an original base pin or rewrites terminal identity", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      n = await nativeOwnershipFixture(f, proof, peer);
    try {
      await n.api.reserve(n.assets, n.client, n.pending);
      const cancelled = n.client.originalNeverInvoked(n.pending);
      const cleanup = await confirmNativeMobileGatewayAssetsCancellation(
        proof,
        n.assets,
        n.client,
        n.pending,
        cancelled,
      );
      const terminal = f.read(),
        path = mobileGatewayAssetsPath(n.assets);
      if (terminal.schemaVersion !== 3 || !terminal.mobile.gatewayLifecycle)
        throw Error("Missing terminal fixture.");
      f.replaceState({
        ...terminal,
        pins: [
          {
            owner: mobileGatewayBuildPin(n.client.binding(n.pending).nonce),
            buildId: n.context.binding.buildId,
          },
        ],
      });
      await expect(
        confirmNativeMobileGatewayAssetsCancellation(
          proof,
          n.assets,
          n.client,
          n.pending,
          cancelled,
        ),
      ).rejects.toThrow(/terminal base pin/);
      await expect(removeMobileGatewayAssets(proof, n.assets, cleanup)).rejects.toThrow(/pin/);
      f.replaceState({
        ...terminal,
        mobile: {
          ...terminal.mobile,
          gatewayLifecycle: {
            ...terminal.mobile.gatewayLifecycle,
            attempts: terminal.mobile.gatewayLifecycle.attempts.map((a) =>
              Object.assign({}, a, { controller: { ...a.controller, id: "foreign-controller" } }),
            ),
          },
        },
      });
      await expect(removeMobileGatewayAssets(proof, n.assets, cleanup)).rejects.toThrow(
        /terminal proof changed/,
      );
      expect(await fs.readFile(join(path, "index.html"), "utf8")).toContain("fixture");
    } finally {
      await n.close();
    }
  });
});

it("preserves native intent and bytes when actual opaque exit names a foreign original controller", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      n = await nativeOwnershipFixture(f, proof, peer, { originalPidOffset: 1 });
    try {
      const intent = await n.api.reserve(n.assets, n.client, n.pending);
      await n.api.markInvoked(intent!);
      await n.client.start(n.pending);
      const result = await n.client.stopOriginal(n.pending);
      if (result.state !== "exited") throw Error("Controlled foreign exit missing.");
      await expect(
        confirmNativeMobileGatewayAssetsExit(proof, n.assets, n.client, n.pending, result.exit),
      ).rejects.toThrow(/original controller differs/);
      await expect(removeMobileGatewayAssets(proof, n.assets)).rejects.toThrow(/Native transfer/);
      expect(f.read().pins).toHaveLength(1);
      expect(
        await fs.readFile(join(mobileGatewayAssetsPath(n.assets), "index.html"), "utf8"),
      ).toContain("fixture");
    } finally {
      await n.close();
    }
  });
});
