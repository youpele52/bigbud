import type { VerifiedMobilePublication } from "../remote-agent/mobileOptionalPublication.ts";
import type { MobilePublicationAuthority } from "../remote-agent/mobileOptionalPublication.authority.ts";
import {
  assertOriginalNativeServiceLeaseClient,
  type NativeServiceLeaseClient,
  type PendingOriginalNativeLease,
  type ConfirmedNativeLeaseExit,
  type ConfirmedNativeCancelFence,
  type OriginalNeverInvoked,
} from "../remote-agent/remoteAgentServiceLeaseClient.ts";
import { mobileGatewayBuildPin } from "../remote-agent/mobileGatewayLifecycle.transitions.ts";
import { completeNativeMobileGatewayAttempt } from "../remote-agent/mobileGatewayLifecycle.native.transitions.ts";
import type {
  MobileNativeGatewayCompletion,
  MobileNativeGatewayOwnership,
} from "../remote-agent/mobileGatewayLifecycle.native.schema.ts";
import { mobileRegistryOwnerEqual } from "../remote-agent/remoteAgentInstall.mobile.schema.ts";
import {
  withMobileGatewayAssetsTeardown,
  type OwnedMobileGatewayAssets,
} from "./mobileGatewayProcess.assets.ts";
import {
  mobileAssetsReceiptFileState,
  verifyMobileAssetsReceiptFile,
} from "./mobileGatewayAssets.receipt.files.ts";

declare const cleanupBrand: unique symbol;
export interface VerifiedNativeMobileGatewayAssetsCleanup {
  readonly [cleanupBrand]: true;
}
interface Cleanup {
  readonly token: OwnedMobileGatewayAssets;
  readonly authority: MobilePublicationAuthority;
  readonly nonce: string;
  readonly attemptSnapshot: string;
}
const cleanups = new WeakMap<VerifiedNativeMobileGatewayAssetsCleanup, Cleanup>();
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function confirm(
  proof: VerifiedMobilePublication,
  token: OwnedMobileGatewayAssets,
  client: NativeServiceLeaseClient,
  pending: PendingOriginalNativeLease,
  evidence: {
    readonly binding: MobileNativeGatewayOwnership["binding"];
    readonly completion: MobileNativeGatewayCompletion;
  },
): Promise<VerifiedNativeMobileGatewayAssetsCleanup> {
  assertOriginalNativeServiceLeaseClient(client);
  const view = client.original(pending);
  if (!equal(view.binding, evidence.binding) || view.assetsArgument !== "--assets-dir")
    throw Error("Original native terminal proof and fixed assets binding required.");
  const original: MobileNativeGatewayOwnership = { ...view, assetsArgument: "--assets-dir" };
  return withMobileGatewayAssetsTeardown(proof, token, async (data, authority, signal) => {
    const receipt = mobileAssetsReceiptFileState(token);
    if (
      !receipt ||
      !equal(receipt.reference, view.assetsReference) ||
      data.nonce !== view.binding.nonce
    )
      throw Error("Original assets receipt/preparation nonce differs from native pending.");
    await verifyMobileAssetsReceiptFile(receipt, `${data.path}.receipt.json`, signal);
    const state = await authority.registry(signal).read();
    const attempt =
      state.schemaVersion === 3 &&
      state.mobile.gatewayLifecycle?.attempts.find((a) => a.nonce === data.nonce);
    if (
      !attempt ||
      attempt.stageId !== data.stageId ||
      attempt.releaseId !== data.releaseId ||
      attempt.consentRevision !== data.consentRevision
    )
      throw Error("Exact original native CAS/publication tuple required before cleanup.");
    const terminal = await authority
      .registry(signal)
      .update((current) =>
        completeNativeMobileGatewayAttempt(
          current,
          authority.pin,
          original,
          evidence.completion,
          Date.now(),
        ),
      );
    const terminalAttempt =
      terminal.schemaVersion === 3 &&
      terminal.mobile.gatewayLifecycle?.attempts.find((a) => a.nonce === data.nonce);
    if (!terminalAttempt || terminalAttempt.phase !== "exit-confirmed")
      throw Error("Exact native terminal CAS acknowledgement required.");
    await authority.assertAuthority();
    const capability = Object.freeze({}) as VerifiedNativeMobileGatewayAssetsCleanup;
    const value: Cleanup = {
      token,
      authority,
      nonce: original.binding.nonce,
      attemptSnapshot: JSON.stringify(terminalAttempt),
    };
    cleanups.set(capability, value);
    await assertNativeMobileGatewayAssetsCleanup(capability, token, authority);
    return capability;
  });
}

/** No live lease/JSON/PID can pass the exit-only original client accessor. */
export async function confirmNativeMobileGatewayAssetsExit(
  proof: VerifiedMobilePublication,
  token: OwnedMobileGatewayAssets,
  client: NativeServiceLeaseClient,
  pending: PendingOriginalNativeLease,
  exit: ConfirmedNativeLeaseExit,
): Promise<VerifiedNativeMobileGatewayAssetsCleanup> {
  assertOriginalNativeServiceLeaseClient(client);
  const evidence = client.exitEvidence(exit);
  if (!evidence.originalController)
    return Promise.reject(Error("Original native exit controller required."));
  const completion: MobileNativeGatewayCompletion = {
    kind: "native-exit",
    generation: evidence.generation,
    originalChildPid: evidence.originalChildPid,
    originalController: evidence.originalController,
    ...(evidence.currentController ? { currentController: evidence.currentController } : {}),
    ...(evidence.previousController ? { previousController: evidence.previousController } : {}),
  };
  return confirm(proof, token, client, pending, { binding: evidence.binding, completion });
}
/** Kind is read from a private terminal map, never supplied by the caller. */
export async function confirmNativeMobileGatewayAssetsCancellation(
  proof: VerifiedMobilePublication,
  token: OwnedMobileGatewayAssets,
  client: NativeServiceLeaseClient,
  pending: PendingOriginalNativeLease,
  cancellation: ConfirmedNativeCancelFence | OriginalNeverInvoked,
): Promise<VerifiedNativeMobileGatewayAssetsCleanup> {
  assertOriginalNativeServiceLeaseClient(client);
  const evidence = client.cancellationEvidence(cancellation);
  return confirm(proof, token, client, pending, {
    binding: evidence.binding,
    completion: {
      kind: evidence.kind === "never-invoked" ? "native-never-invoked" : "native-cancel",
    },
  });
}

/** Called inside the original publisher teardown queue immediately before any deletion. */
export async function assertNativeMobileGatewayAssetsCleanup(
  proof: VerifiedNativeMobileGatewayAssetsCleanup,
  token: OwnedMobileGatewayAssets,
  authority: MobilePublicationAuthority,
): Promise<void> {
  const record = cleanups.get(proof);
  if (!record || record.token !== token || record.authority !== authority)
    throw Error("Original native terminal/CAS cleanup capability required.");
  await authority.assertAuthority();
  const state = await authority.registry().read();
  const attempt =
    state.schemaVersion === 3 &&
    mobileRegistryOwnerEqual(state.mobile.owner, authority.pin) &&
    state.mobile.gatewayLifecycle?.attempts.find((a) => a.nonce === record.nonce);
  if (
    !attempt ||
    attempt.phase !== "exit-confirmed" ||
    JSON.stringify(attempt) !== record.attemptSnapshot
  )
    throw Error("Durable exact native terminal proof changed; preserve all assets.");
  if (state.pins.some((p) => p.owner === mobileGatewayBuildPin(record.nonce)))
    throw Error("Native terminal base pin remains; preserve assets until admitted repair.");
  await authority.assertAuthority();
}
