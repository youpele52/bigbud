import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { mobileGatewayCommand } from "@bigbud/shared/mobileGatewaySupervisor.config";
import { BackendInstance } from "../startup/backendInstance.ts";
import { ServerConfig } from "../startup/config.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import type { VerifiedMobilePublication } from "../remote-agent/mobileOptionalPublication.ts";
import {
  MobileGatewayConfiguration,
  validateMobileGatewayConfiguration,
} from "../remote-agent/mobileGatewayLifecycle.schema.ts";
import { mobileRegistryOwnerEqual } from "../remote-agent/remoteAgentInstall.mobile.schema.ts";
import { makeNativeMobileGatewayOwnership } from "../remote-agent/mobileGatewayLifecycle.native.owner.ts";
import { nativeLeaseLaunchFingerprint } from "../remote-agent/remoteAgentServiceLease.launch.ts";
import {
  type OriginalNativeLeaseAttempt,
  type PendingOriginalNativeLease,
} from "../remote-agent/remoteAgentServiceLeaseClient.ts";
import {
  managedNativeLeaseChannel,
  type ManagedNativeLeaseChannel,
} from "./localSupervisorService.leaseChannel.ts";
import {
  assertNativeLeaseCapabilityDerivation,
  type NativeLeaseCapabilityDerivation,
} from "./authority.nativeLeaseCapability.ts";
import { canonicalNativeMobileCapabilityContext } from "./mobileGatewayNative.capability.ts";
import { makeNativeMobileGatewayGuard } from "./mobileGatewayNative.guard.ts";
import {
  withOriginalMobileGatewayAssets,
  type OwnedMobileGatewayAssets,
} from "./mobileGatewayProcess.assets.ts";
import { mobileAssetsReceiptFileState } from "./mobileGatewayAssets.receipt.files.ts";
import {
  captureSealedMobileGatewaySocket,
  mobileGatewayProcessConfiguration,
} from "./mobileGatewayProcess.config.ts";

interface NativePreparationOptions {
  readonly channel: ManagedNativeLeaseChannel;
}
/** No adapter requires no runtime environment or optional IO. */
export function makeNativeMobileGatewayLaunchPreparation(): Effect.Effect<null>;
export function makeNativeMobileGatewayLaunchPreparation(
  proof: VerifiedMobilePublication,
  input: unknown,
  options: NativePreparationOptions,
): ReturnType<typeof prepareWithManagedChannel>;
export function makeNativeMobileGatewayLaunchPreparation(
  proof?: VerifiedMobilePublication,
  input?: unknown,
  options?: NativePreparationOptions,
) {
  if (!options) return Effect.succeed(null);
  if (!proof) throw Error("Original publication proof required with the managed adapter.");
  return prepareWithManagedChannel(proof, input, options);
}
/** This factory prepares original native intent only. It never sends Start or grants readiness. */
const prepareWithManagedChannel = Effect.fn("makeNativeMobileGatewayLaunchPreparation")(function* (
  proof: VerifiedMobilePublication,
  input: unknown,
  options: NativePreparationOptions,
) {
  const channel = managedNativeLeaseChannel(options.channel);
  channel.client.assertActivationCapability();
  const owner = yield* BackendInstance,
    identity = yield* RemoteBackendIdentityService,
    config = yield* ServerConfig;
  const candidate = identity.deriveNativeLeaseCapability;
  assertNativeLeaseCapabilityDerivation(candidate, identity.authority.keyFingerprint);
  // Capture the authenticated original function with its definite type across async callbacks.
  const derive: NativeLeaseCapabilityDerivation = candidate;
  const configuration = Object.freeze(
    Schema.decodeUnknownSync(MobileGatewayConfiguration)(input, { onExcessProperty: "error" }),
  );
  validateMobileGatewayConfiguration(configuration);
  const guardFor = yield* makeNativeMobileGatewayGuard(proof, configuration);
  const ownership = yield* makeNativeMobileGatewayOwnership(proof, configuration);
  const prepared = new WeakMap<PendingOriginalNativeLease, OwnedMobileGatewayAssets>();
  const client = channel.client;
  async function prepare(
    assets: OwnedMobileGatewayAssets,
    attempt: OriginalNativeLeaseAttempt,
    external?: AbortSignal,
  ): Promise<PendingOriginalNativeLease> {
    client.assertActivationCapability();
    await channel.assertCurrent();
    const nonce = client.attemptNonce(attempt);
    const guard = await guardFor(assets, client, attempt, external);
    return withOriginalMobileGatewayAssets(
      proof,
      assets,
      async (data, publication, signal, assertCurrent) => {
        if (data.transferArmed || data.nonce !== nonce)
          throw Error("Fresh original unarmed native assets/attempt required.");
        if (
          !mobileRegistryOwnerEqual(publication.paths.owner, identity) ||
          data.stateDir !== owner.stateDir
        )
          throw Error("Actual held identity/publication mismatch.");
        const reference = mobileAssetsReceiptFileState(assets)?.reference;
        if (!reference) throw Error("Original immutable assets receipt required.");
        const process = mobileGatewayProcessConfiguration(owner, config, {
          nonce,
          ...configuration,
        });
        const assertSocket = captureSealedMobileGatewaySocket(process.upstream.path);
        const command = mobileGatewayCommand({
          binary: publication.paths.gatewayPath,
          port: configuration.port,
          externalOrigin: configuration.externalOrigin,
          upstream: process.upstream,
          credential: process.credential,
          assetsDir: data.path,
        });
        const executableSha256 = Buffer.from(publication.paths.gatewayArtifact.sha256, "hex");
        const body = {
          executable: publication.paths.gatewayPath,
          args: command.args,
          environment: Object.entries(command.env)
            .filter((entry): entry is [string, string] => entry[1] !== undefined)
            .map(([name, value]) => ({ name, value })),
          guard,
          assetsGeneration: reference.generation,
          assetsReceiptSize: reference.sizeBytes,
          assetsReceiptSha256: Buffer.from(reference.sha256, "hex"),
          assetsArgument: "--assets-dir",
        };
        const configurationSha256 = nativeLeaseLaunchFingerprint(owner.stateDir, {
          ...body,
          binding: { executableSha256 },
        });
        const original = {
          binding: {
            authority: identity.authority.authorityId,
            installation: identity.installationFingerprint,
            nativeEpoch: channel.nativeEpoch,
            nonce,
            publicationSha256: publication.paths.releaseId.slice("mobile-release:".length),
            executableSha256: executableSha256.toString("hex"),
            assetsSha256: publication.paths.assetsArtifact.sha256,
            configurationSha256: Buffer.from(configurationSha256).toString("hex"),
            guardSha256: createHash("sha256").update(guard).digest("hex"),
          },
          assetsReference: reference,
          assetsArgument: "--assets-dir",
        };
        const capability = derive(
          canonicalNativeMobileCapabilityContext({ owner: publication.paths.owner, original }),
        );
        await assertCurrent();
        await channel.assertCurrent();
        assertSocket();
        signal.throwIfAborted();
        const pending = client.prepareStart(attempt, {
          ...body,
          requestId: nonce,
          binding: {
            ...original.binding,
            publicationSha256: Buffer.from(original.binding.publicationSha256, "hex"),
            executableSha256,
            assetsSha256: Buffer.from(original.binding.assetsSha256, "hex"),
            configurationSha256,
            guardSha256: Buffer.from(original.binding.guardSha256, "hex"),
          },
          capability,
        });
        prepared.set(pending, assets);
        return pending;
      },
      external,
    );
  }
  return Object.freeze({
    prepare,
    reserve: (pending: PendingOriginalNativeLease, signal?: AbortSignal) => {
      const assets = prepared.get(pending);
      if (!assets)
        return Promise.reject(Error("Original prepared managed native intent required."));
      return ownership.reserve(assets, client, pending, signal);
    },
    markInvoked: ownership.markInvoked,
  });
});
