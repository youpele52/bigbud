/** Offline Linux proof: real signed files/flock CAS/P4 probe, explicitly synthetic native wire. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as Effect from "effect/Effect";
import { ownerIntegrationArtifacts } from "../remote-backend/mobileGatewayOwner.integration.artifacts.ts";
import { createOwnerIntegrationFixture } from "../remote-backend/mobileGatewayOwner.integration.fixture.ts";
import { withMobileOptionalPublisher } from "./mobileOptionalPublication.ts";
import { revalidateMobilePublicationToken } from "./mobileGatewayLifecycle.publication.ts";
import { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { connectNativeServiceLeaseClient } from "./remoteAgentServiceLeaseClient.ts";
import { makeNativeMobileGatewayOwnership } from "./mobileGatewayLifecycle.native.owner.ts";
import {
  nativeOwnershipFixtureLaunch,
  nativeOwnershipFixtureController,
} from "./mobileGatewayLifecycle.native.launch.fixture.ts";
import {
  prepareMobileGatewayAssets,
  mobileGatewayAssetsPath,
  removeMobileGatewayAssets,
} from "../remote-backend/mobileGatewayProcess.assets.ts";
import { writeMobileGatewayAssetsReceipt } from "../remote-backend/mobileGatewayAssets.receipt.ts";
import { confirmNativeMobileGatewayAssetsExit } from "../remote-backend/mobileGatewayAssets.nativeCleanup.ts";
import { pinRemoteAgentBuild } from "./remoteAgentInstall.registry.transitions.ts";

const peer = process.env.BIGBUD_TEST_NATIVE_PEER;
if (!peer) throw Error("Explicit controlled native wire peer required.");
const artifacts = await ownerIntegrationArtifacts(),
  f = await createOwnerIntegrationFixture(artifacts);
try {
  await Effect.runPromise(f.settings.updateSettings({ mobileRemoteControl: { enabled: true } }));
  await Effect.runPromise(
    withMobileOptionalPublisher(artifacts.keys, async (publisher) => {
      const proof = await publisher.publish(artifacts.request),
        paths = await revalidateMobilePublicationToken(proof);
      const initial = await f.store.read();
      const epoch = initial.launches.find(
        (l) => l.buildId === initial.current && l.phase === "ready",
      )?.epoch;
      if (!epoch) throw Error("Existing canonical fixture epoch unavailable.");
      const connection = RemoteAgentConnection.local({
        binaryPath: process.execPath,
        args: [peer],
        env: {
          ...nativeOwnershipFixtureController(f.owner.startedAt),
          BIGBUD_TEST_NATIVE_EPOCH: epoch,
        },
      });
      const client = await connectNativeServiceLeaseClient(connection, {
        nativeEpoch: epoch,
        stateDir: f.owner.stateDir,
      });
      try {
        const attempt = client.beginAttempt(),
          nonce = client.attemptNonce(attempt);
        const assets = await prepareMobileGatewayAssets(proof, nonce, new AbortController().signal);
        const reference = await writeMobileGatewayAssetsReceipt(proof, assets);
        const pending = client.prepareStart(
          attempt,
          nativeOwnershipFixtureLaunch({
            owner: paths.owner,
            releaseId: paths.releaseId,
            gatewaySha256: paths.gatewayArtifact.sha256,
            assetsSha256: paths.assetsArtifact.sha256,
            stateDir: f.owner.stateDir,
            epoch,
            nonce,
            reference,
          }),
        );
        const ownership = await Effect.runPromise(
          makeNativeMobileGatewayOwnership(proof, {
            externalOrigin: "https://phone.fixture.example",
            port: 49322,
          }).pipe(Effect.provide(f.runtimeLayer)),
        );
        const intent = await ownership.reserve(assets, client, pending);
        assert.ok(intent);
        await ownership.markInvoked(intent);
        await assert.rejects(ownership.markInvoked(intent), /unspent/);
        await client.start(pending); // Controlled wire grant only; no native child exists in this proof.
        await f.store.update((s) => pinRemoteAgentBuild(s, "unrelated-client", s.current!));
        await Effect.runPromise(
          f.settings.updateSettings({ mobileRemoteControl: { enabled: false } }),
        );
        await f.consent(false);
        const result = await client.stopOriginal(pending);
        if (result.state !== "exited")
          throw Error("Controlled native terminal attestation missing.");
        const cleanup = await confirmNativeMobileGatewayAssetsExit(
          proof,
          assets,
          client,
          pending,
          result.exit,
        );
        const terminal = await f.store.read();
        assert.equal(terminal.schemaVersion, 3);
        assert.equal(terminal.pins.length, 1);
        assert.equal(terminal.pins[0]!.owner, "unrelated-client");
        const path = mobileGatewayAssetsPath(assets);
        await removeMobileGatewayAssets(proof, assets, cleanup);
        await assert.rejects(fs.lstat(path));
        await assert.rejects(fs.lstat(`${path}.receipt.json`));
        console.log(
          "Actual Linux signed assets+receipt/original opaque client over SYNTHETIC native wire+live P4 probe+durable same-CAS native intent/pin+spent permit+revoke+terminal proof+exact cleanup PASS; no native child/activation claim",
        );
      } finally {
        await client.dispose();
      }
    }).pipe(Effect.provide(f.runtimeLayer)),
  );
} finally {
  await f.close();
}
