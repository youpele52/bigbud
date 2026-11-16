import * as fs from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import * as Effect from "effect/Effect";
import { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { connectNativeServiceLeaseClient } from "./remoteAgentServiceLeaseClient.ts";
import {
  nativeOwnershipFixtureLaunch,
  nativeOwnershipFixtureController,
} from "./mobileGatewayLifecycle.native.launch.fixture.ts";
import { BackendInstance } from "../startup/backendInstance.ts";
import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import {
  gatewayConfiguration,
  gatewayContext,
  gatewayFixtureOwnerStore,
} from "./mobileGatewayLifecycle.test-fixtures.ts";
import { makeNativeMobileGatewayOwnership } from "./mobileGatewayLifecycle.native.owner.ts";
import type { publicationFixture } from "./mobileOptionalPublication.test-fixtures.ts";
import type { VerifiedMobilePublication } from "./mobileOptionalPublication.ts";
import { prepareMobileGatewayAssets } from "../remote-backend/mobileGatewayProcess.assets.ts";
import { writeMobileGatewayAssetsReceipt } from "../remote-backend/mobileGatewayAssets.receipt.ts";

/** Actual pipe + actual opaque client, controlled wire attestations, never native ownership proof. */
export async function nativeOwnershipFixture(
  f: Awaited<ReturnType<typeof publicationFixture>>,
  proof: VerifiedMobilePublication,
  peer: string,
  options: { readonly originalPidOffset?: number } = {},
) {
  const context = gatewayContext(f);
  const connection = RemoteAgentConnection.local({
    binaryPath: process.execPath,
    args: [peer],
    env: {
      ...nativeOwnershipFixtureController(f.owner().startedAt),
      BIGBUD_TEST_NATIVE_EPOCH: context.binding.epoch,
      BIGBUD_TEST_NATIVE_ORIGINAL_PID_OFFSET: String(options.originalPidOffset ?? 0),
    },
  });
  const client = await connectNativeServiceLeaseClient(connection, {
    nativeEpoch: context.binding.epoch,
    stateDir: f.stateDir,
  });
  try {
    const attempt = client.beginAttempt(),
      nonce = client.attemptNonce(attempt);
    const assets = await prepareMobileGatewayAssets(proof, nonce, new AbortController().signal);
    const reference = await writeMobileGatewayAssetsReceipt(proof, assets);
    const state = f.read();
    if (state.schemaVersion !== 3) throw Error("Missing fixture publication.");
    const release = state.mobile.releases[0]!;
    const pending = client.prepareStart(
      attempt,
      nativeOwnershipFixtureLaunch({
        owner: context.owner,
        releaseId: context.releaseId,
        gatewaySha256: release.gateway.sha256,
        assetsSha256: release.assets.sha256,
        stateDir: f.stateDir,
        epoch: context.binding.epoch,
        nonce,
        reference,
      }),
    );
    const api = await Effect.runPromise(
      makeNativeMobileGatewayOwnership(proof, gatewayConfiguration).pipe(
        Effect.provideService(BackendInstance, f.owner()),
        Effect.provideService(RemoteAgentRuntimeOwners, gatewayFixtureOwnerStore(f)),
      ),
    );
    return {
      client,
      pending,
      assets,
      reference,
      api,
      context,
      attempt,
      close: () => client.dispose(),
    };
  } catch (cause) {
    await client.dispose();
    throw cause;
  }
}
export type NativeOwnershipFixture = Awaited<ReturnType<typeof nativeOwnershipFixture>>;

/** Builds only this repository's explicit synthetic peer with the already-installed Bun tool. */
export async function buildNativeOwnershipFixturePeer() {
  const root = await fs.mkdtemp(join(await fs.realpath("/tmp"), "bb-native-wire-"));
  const peer = join(root, "peer.mjs");
  try {
    execFileSync(
      "bun",
      [
        "build",
        join(import.meta.dirname, "mobileGatewayLifecycle.native.peer.ts"),
        "--target=node",
        `--outfile=${peer}`,
      ],
      { stdio: "pipe" },
    );
  } catch (cause) {
    await fs.rm(root, { recursive: true });
    throw cause;
  }
  return { peer, close: () => fs.rm(root, { recursive: true }) };
}
