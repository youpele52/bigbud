import * as Schema from "effect/Schema";
import type { MobileGatewayAttempt } from "../remote-agent/mobileGatewayLifecycle.schema.ts";
import { MobileNativeGatewayOwnership } from "../remote-agent/mobileGatewayLifecycle.native.schema.ts";
import {
  MobileRegistryOwnerSchema,
  mobileRegistryOwnerEqual,
  type MobileRegistryOwner,
} from "../remote-agent/remoteAgentInstall.mobile.schema.ts";
import type { RemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import {
  assertOriginalNativeServiceLeaseClient,
  type NativeServiceLeaseClient,
  type PendingOriginalNativeLease,
} from "../remote-agent/remoteAgentServiceLeaseClient.ts";
import type { BackendInstanceShape } from "../startup/backendInstance.ts";
import type { RemoteBackendIdentity } from "./authority.ts";
import { assertNativeLeaseCapabilityDerivation } from "./authority.nativeLeaseCapability.ts";
import { canonicalNativeMobileCapabilityContext } from "./mobileGatewayNative.capability.ts";

/** One `attempted` native row of a predecessor controller, with its journal owner. */
export interface NativeMobileSuccessorCandidate {
  readonly attempt: MobileGatewayAttempt & {
    readonly nativeOwnership: MobileNativeGatewayOwnership;
  };
  readonly owner: MobileRegistryOwner;
}
export type NativeMobileSuccessorSelection =
  | { readonly kind: "none" }
  /** More than one foreign original: never pick one; owner repair decides. */
  | { readonly kind: "conflict" }
  | ({ readonly kind: "one" } & NativeMobileSuccessorCandidate);

/**
 * Select at most one `attempted` native row whose controller is not this backend instance. Rows
 * without native ownership (legacy Node children) and `reserved` rows are never adopted here.
 */
export function selectNativeMobileSuccessor(
  state: RemoteAgentRegistry,
  current: Pick<BackendInstanceShape, "nonce" | "pid" | "startedAt">,
): NativeMobileSuccessorSelection {
  if (state.schemaVersion !== 3) return { kind: "none" };
  // The current controller: a successor that adopted the original, else the original one.
  const foreign = (state.mobile.gatewayLifecycle?.attempts ?? []).filter((a) => {
    const controller = a.currentController ?? a.controller;
    return (
      a.phase === "attempted" &&
      a.nativeOwnership !== undefined &&
      !(
        controller.id === current.nonce &&
        controller.pid === current.pid &&
        controller.startedAt === current.startedAt
      )
    );
  });
  if (foreign.length === 0) return { kind: "none" };
  const attempt = foreign[0];
  if (foreign.length > 1 || !attempt?.nativeOwnership) return { kind: "conflict" };
  return Object.freeze({
    kind: "one" as const,
    attempt: attempt as NativeMobileSuccessorCandidate["attempt"],
    owner: state.mobile.owner,
  });
}

const digest = (hex: string): Uint8Array => {
  const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
  if (!/^[a-f0-9]{64}$/.test(hex) || Buffer.from(bytes).toString("hex") !== hex)
    throw Error("Journal native digest is not canonical hex.");
  return bytes;
};
const strict = { onExcessProperty: "error" } as const;

/**
 * Rebuild the retained original intent from the canonical journal row: hex digests become bytes,
 * the capability is re-derived by the held private signer from the same canonical context as
 * preparation, and the assets fields come from the immutable receipt reference. The client then
 * re-validates the epoch, so a lease retained under an older Rust epoch is refused (repair), never
 * replaced by a fresh Start. The restored intent must re-render the exact journal identity.
 */
export function restoreNativeMobileGatewayLease(
  client: NativeServiceLeaseClient,
  identity: RemoteBackendIdentity,
  journalOwner: unknown,
  ownership: unknown,
): PendingOriginalNativeLease {
  assertOriginalNativeServiceLeaseClient(client);
  let owner: MobileRegistryOwner, original: MobileNativeGatewayOwnership;
  try {
    owner = Schema.decodeUnknownSync(MobileRegistryOwnerSchema)(journalOwner, strict);
    original = Schema.decodeUnknownSync(MobileNativeGatewayOwnership)(ownership, strict);
  } catch {
    throw Error("Invalid journal native ownership.");
  }
  if (!mobileRegistryOwnerEqual(owner, identity))
    throw Error("Journal owner differs from the held identity.");
  const derive = identity.deriveNativeLeaseCapability;
  assertNativeLeaseCapabilityDerivation(derive, identity.authority.keyFingerprint);
  const context = canonicalNativeMobileCapabilityContext({ owner, original });
  const { binding, assetsReference } = original;
  const pending = client.restorePending({
    binding: {
      authority: binding.authority,
      installation: binding.installation,
      nativeEpoch: binding.nativeEpoch,
      nonce: binding.nonce,
      publicationSha256: digest(binding.publicationSha256),
      executableSha256: digest(binding.executableSha256),
      assetsSha256: digest(binding.assetsSha256),
      configurationSha256: digest(binding.configurationSha256),
      guardSha256: digest(binding.guardSha256),
    },
    capability: derive(context),
    assetsGeneration: assetsReference.generation,
    assetsReceiptSize: assetsReference.sizeBytes,
    assetsReceiptSha256: digest(assetsReference.sha256),
    assetsArgument: original.assetsArgument,
  });
  const restored = canonicalNativeMobileCapabilityContext({
    owner,
    original: client.original(pending),
  });
  if (!restored.equals(context)) throw Error("Restored native intent differs from the journal.");
  return pending;
}
