import { completeNativeMobileGatewayAttempt } from "../remote-agent/mobileGatewayLifecycle.native.transitions.ts";
import type { MobileNativeGatewayOwnership } from "../remote-agent/mobileGatewayLifecycle.native.schema.ts";
import type { MobileRegistryOwner } from "../remote-agent/remoteAgentInstall.mobile.schema.ts";
import type { RemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import {
  assertOriginalNativeServiceLeaseClient,
  type ConfirmedNativeLeaseExit,
  type NativeServiceLeaseClient,
  type PendingOriginalNativeLease,
} from "../remote-agent/remoteAgentServiceLeaseClient.ts";
import { nativeExitCompletion } from "./mobileGatewayAssets.nativeCleanup.ts";
import { canonicalNativeMobileCapabilityContext } from "./mobileGatewayNative.capability.ts";

/**
 * The canonical CAS journal of a held authority: the publication authority (through
 * `withMobilePublicationTeardown`) while a successor holds a publication proof, or the activation
 * authority when consent was already off and no publication could be reminted.
 */
export interface NativeMobileSuccessorJournal {
  readonly pin: MobileRegistryOwner;
  readonly registry: (signal: AbortSignal) => {
    readonly update: (
      transition: (state: RemoteAgentRegistry) => RemoteAgentRegistry,
    ) => Promise<RemoteAgentRegistry>;
  };
}

/**
 * Journal-only terminal record of an original native gateway after a successor observed its
 * confirmed exit (Gone, revoke, or stop after successor readiness). Same transition and evidence
 * as the original-controller cleanup, which also releases the attempt's base pin.
 *
 * Residual (increment 7): the successor never re-adopts the original runtime assets tree; by
 * design an armed tree cannot be re-adopted after its controller died
 * (`mobileGatewayProcess.assets.ts`). The tree is left in place for the orphan runtime-asset
 * repair/GC path; this records the exit only and removes no files.
 */
export async function recordNativeMobileSuccessorExit(
  journal: NativeMobileSuccessorJournal,
  client: NativeServiceLeaseClient,
  pending: PendingOriginalNativeLease,
  original: MobileNativeGatewayOwnership,
  exit: ConfirmedNativeLeaseExit,
  signal: AbortSignal,
): Promise<void> {
  assertOriginalNativeServiceLeaseClient(client);
  signal.throwIfAborted();
  const evidence = client.exitEvidence(exit);
  const restored = { owner: journal.pin, original: client.original(pending) };
  const expected = canonicalNativeMobileCapabilityContext({ owner: journal.pin, original });
  if (
    !canonicalNativeMobileCapabilityContext(restored).equals(expected) ||
    JSON.stringify(evidence.binding) !== JSON.stringify(restored.original.binding)
  )
    throw Error("Successor exit evidence differs from the retained original intent.");
  const completion = nativeExitCompletion(evidence);
  const terminal = await journal
    .registry(signal)
    .update((current) =>
      completeNativeMobileGatewayAttempt(current, journal.pin, original, completion, Date.now()),
    );
  const attempt =
    terminal.schemaVersion === 3 &&
    terminal.mobile.gatewayLifecycle?.attempts.find((a) => a.nonce === original.binding.nonce);
  if (!attempt || attempt.phase !== "exit-confirmed")
    throw Error("Exact native terminal CAS acknowledgement required.");
}
