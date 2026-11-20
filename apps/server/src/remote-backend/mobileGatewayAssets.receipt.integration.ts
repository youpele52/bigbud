/** Explicit offline Linux entry: controlled signer/P4 peer, real filesystem/CAS and Rust gateway. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ownerIntegrationArtifacts } from "./mobileGatewayOwner.integration.artifacts.ts";
import { createOwnerIntegrationFixture } from "./mobileGatewayOwner.integration.fixture.ts";
import { withMobileOptionalPublisher } from "../remote-agent/mobileOptionalPublication.ts";
import {
  prepareMobileGatewayAssets,
  mobileGatewayAssetsPath,
  removeMobileGatewayAssets,
} from "./mobileGatewayProcess.assets.ts";
import { writeMobileGatewayAssetsReceipt } from "./mobileGatewayAssets.receipt.ts";
import { MobileAssetsReceipt } from "./mobileGatewayAssets.receipt.schema.ts";
import { canonicalMobileAssetsReceipt } from "./mobileGatewayAssets.receipt.format.ts";

const artifacts = await ownerIntegrationArtifacts(),
  f = await createOwnerIntegrationFixture(artifacts);
try {
  await Effect.runPromise(f.settings.updateSettings({ mobileRemoteControl: { enabled: true } }));
  await Effect.runPromise(
    withMobileOptionalPublisher(artifacts.keys, async (publisher) => {
      const proof = await publisher.publish(artifacts.request),
        token = await prepareMobileGatewayAssets(
          proof,
          "actual-linux-receipt",
          new AbortController().signal,
        );
      const path = mobileGatewayAssetsPath(token),
        before = await f.store.read();
      const reference = await writeMobileGatewayAssetsReceipt(proof, token),
        bytes = await fs.readFile(`${path}.receipt.json`);
      assert.equal(bytes.length, reference.sizeBytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), reference.sha256);
      assert.deepEqual(canonicalMobileAssetsReceipt(JSON.parse(bytes.toString("utf8"))), bytes);
      const receipt = Schema.decodeUnknownSync(MobileAssetsReceipt)(
        JSON.parse(bytes.toString("utf8")),
        { onExcessProperty: "error" },
      );
      assert.deepEqual(receipt.owner.authority, f.identity.authority);
      assert.equal(receipt.owner.installationFingerprint, f.identity.installationFingerprint);
      assert.equal(receipt.controller.id, f.owner.nonce);
      assert.equal(receipt.controllerHost.hostname, f.owner.hostname);
      assert.equal(
        receipt.anchors.state.ino,
        (await fs.lstat(f.owner.stateDir, { bigint: true })).ino.toString(),
      );
      assert.equal(receipt.anchors.root.uid, String(process.getuid!()));
      assert.deepEqual(await f.store.read(), before); // Receipt is data, never a second approval registry.
      assert.deepEqual(await writeMobileGatewayAssetsReceipt(proof, token), reference);
      await removeMobileGatewayAssets(proof, token);
      await assert.rejects(fs.lstat(path));
      await assert.rejects(fs.lstat(`${path}.receipt.json`));
      console.log(
        "Actual Linux original-assets receipt+complete content hashes+owned anchors+canonical file SHA+immutable idempotence+CAS unchanged+unarmed cleanup PASS",
      );
    }).pipe(Effect.provide(f.runtimeLayer)),
  );
} finally {
  await f.close();
}
// The existing real Rust direct-child fixture must continue passing after walker/scope extraction.
await import("./mobileGatewayActivation.integration.ts");
