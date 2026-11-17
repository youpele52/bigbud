import * as fs from "node:fs/promises";
import {
  withMobileOptionalPublisher,
  type MobileOptionalPublisher,
  type VerifiedMobilePublication,
} from "../remote-agent/mobileOptionalPublication.ts";
import type { RemoteMobileNativeInputsValue } from "./mobileGatewayActivation.inputs.ts";

/** Publish once, or remint the already-published stage of the current durable consent. */
export async function verifiedNativeMobilePublication(
  publisher: MobileOptionalPublisher,
  inputs: RemoteMobileNativeInputsValue,
  consentRevision: number,
  published: boolean,
  signal: AbortSignal,
): Promise<VerifiedMobilePublication> {
  const { artifacts } = inputs;
  if (published) return publisher.remint(artifacts.stageId, consentRevision);
  const [gatewayBytes, assetsBytes] = await Promise.all([
    fs.readFile(artifacts.gatewayPath, { signal }),
    fs.readFile(artifacts.assetsPath, { signal }),
  ]);
  signal.throwIfAborted();
  return publisher.publish({
    stageId: artifacts.stageId,
    consentRevision,
    gateway: artifacts.gateway,
    assets: artifacts.assets,
    gatewayBytes,
    assetsBytes,
  });
}

/**
 * Hold one owner-trusted publisher for a native session's whole lifetime: obtain a verified proof
 * (publish or remint), then `use` it while the publication scope is held. `retired` cancels the
 * acquisition; `lifetime` aborts when the publication scope is lost, which hands any running
 * original child to a successor and never kills it.
 */
export function withNativeMobilePublication<A>(
  trustedKeys: Readonly<Record<string, string>>,
  retired: AbortSignal,
  obtain: (
    publisher: MobileOptionalPublisher,
    signal: AbortSignal,
  ) => Promise<VerifiedMobilePublication>,
  use: (proof: VerifiedMobilePublication, lifetime: AbortSignal, signal: AbortSignal) => Promise<A>,
) {
  return withMobileOptionalPublisher(trustedKeys, async (publisher, lifetime) => {
    const signal = AbortSignal.any([lifetime, retired]);
    const proof = await obtain(publisher, signal);
    signal.throwIfAborted();
    return use(proof, lifetime, signal);
  });
}
