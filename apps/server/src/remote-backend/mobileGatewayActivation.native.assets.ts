import type * as Effect from "effect/Effect";
import type { VerifiedMobilePublication } from "../remote-agent/mobileOptionalPublication.ts";
import type { OriginalNativeMobileGatewayIntent } from "../remote-agent/mobileGatewayLifecycle.native.owner.ts";
import {
  confirmNativeMobileGatewayAssetsCancellation,
  confirmNativeMobileGatewayAssetsExit,
  type VerifiedNativeMobileGatewayAssetsCleanup,
} from "./mobileGatewayAssets.nativeCleanup.ts";
import { writeMobileGatewayAssetsReceipt } from "./mobileGatewayAssets.receipt.ts";
import type {
  NativeMobileActivationAssets,
  NativeMobileActivationPreparation,
} from "./mobileGatewayActivation.native.ts";
import type { makeNativeMobileGatewayLaunchPreparation } from "./mobileGatewayNative.prepare.ts";
import {
  prepareMobileGatewayAssets,
  removeMobileGatewayAssets,
  type OwnedMobileGatewayAssets,
} from "./mobileGatewayProcess.assets.ts";

type ManagedPreparation = Effect.Success<
  ReturnType<typeof makeNativeMobileGatewayLaunchPreparation>
>;
/** The managed preparation, or `never` if it ever stops fitting the activation port. */
export type ManagedNativeMobileActivationPreparation =
  ManagedPreparation extends NativeMobileActivationPreparation<
    OwnedMobileGatewayAssets,
    OriginalNativeMobileGatewayIntent
  >
    ? ManagedPreparation
    : never;

/** Production assets port: binds the existing original-publication functions, nothing else. */
export function nativeMobileActivationAssets(
  proof: VerifiedMobilePublication,
): NativeMobileActivationAssets<
  OwnedMobileGatewayAssets,
  VerifiedNativeMobileGatewayAssetsCleanup
> {
  const port: NativeMobileActivationAssets<
    OwnedMobileGatewayAssets,
    VerifiedNativeMobileGatewayAssetsCleanup
  > = {
    prepare: (nonce, signal) => prepareMobileGatewayAssets(proof, nonce, signal),
    writeReceipt: (assets, signal) => writeMobileGatewayAssetsReceipt(proof, assets, signal),
    confirmExit: (assets, client, pending, exit) =>
      confirmNativeMobileGatewayAssetsExit(proof, assets, client, pending, exit),
    confirmCancellation: (assets, client, pending, cancellation) =>
      confirmNativeMobileGatewayAssetsCancellation(proof, assets, client, pending, cancellation),
    remove: (assets, cleanup) => removeMobileGatewayAssets(proof, assets, cleanup),
  };
  return Object.freeze(port);
}
