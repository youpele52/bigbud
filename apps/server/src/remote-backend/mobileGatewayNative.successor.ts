import type {
  ConfirmedNativeLeaseExit,
  NativeServiceLeaseClient,
  PendingOriginalNativeLease,
  VerifiedNativeLease,
} from "../remote-agent/remoteAgentServiceLeaseClient.ts";
import type { NativeMobileActivationOutcome } from "./mobileGatewayActivation.launch.ts";
import { holdNativeMobileSuccessorLease } from "./mobileGatewayActivation.native.ts";
import {
  runMobileSuccessorRecovery,
  type MobileSuccessorUpstream,
} from "./mobileGatewayActivation.successor.ts";
import { nativeMobileSuccessorPort } from "./mobileGatewayActivation.successor.native.ts";
import type { NativeMobileGatewaySessionSignals } from "./mobileGatewayNative.session.ts";

/** Resume settlement: `none` means no foreign original exists, so nothing was adopted. */
export type NativeMobileSuccessorOutcome =
  | { readonly kind: "none" }
  | NativeMobileActivationOutcome;

export interface NativeMobileSuccessorAdoption<U extends MobileSuccessorUpstream> {
  readonly client: NativeServiceLeaseClient;
  /** Retained original intent restored from the canonical journal. */
  readonly pending: PendingOriginalNativeLease;
  readonly signals: NativeMobileGatewaySessionSignals;
  /** Canonical journal consent for this attempt. A throw is unknown consent, never "on". */
  readonly consented: (signal: AbortSignal) => Promise<boolean>;
  readonly serveUpstream: (credential: string, signal: AbortSignal) => Promise<U>;
  /** Journal-only exit record; see `mobileGatewayNative.successorExit.ts`. */
  readonly recordExit: (exit: ConfirmedNativeLeaseExit, signal: AbortSignal) => Promise<void>;
  /** Owner admission over the native port after verified readiness; settles before returning. */
  readonly use: (lease: VerifiedNativeLease, upstream: U, signal: AbortSignal) => Promise<unknown>;
}

const repair = (cause: unknown): NativeMobileActivationOutcome => ({
  kind: "failed",
  repairRequired: true,
  cause,
});

/**
 * Adopt one predecessor's original native gateway. An explicit stop request is a consent-off gate
 * for the recovery (native stop, then the journal exit). After readiness the session mirrors a
 * fresh activation: owner admission runs until stop, detach or its own end; then the held lease
 * retires, native stops with a recorded exit unless only a detach was requested (then native
 * detaches), and only after native settles does the credential-bearing upstream close.
 */
export async function adoptNativeMobileSuccessor<U extends MobileSuccessorUpstream>(
  input: NativeMobileSuccessorAdoption<U>,
): Promise<NativeMobileActivationOutcome> {
  const { client, pending } = input,
    { detach, stop } = input.signals;
  const recovered = await runMobileSuccessorRecovery({
    native: nativeMobileSuccessorPort(client, pending),
    consented: async (signal) => !stop.aborted && (await input.consented(signal)),
    serveUpstream: input.serveUpstream,
    recordExit: input.recordExit,
    signal: detach,
  });
  if (recovered.kind === "exited" || recovered.kind === "revoked") return { kind: "exit-recorded" };
  // A retiring controller hands an unsettled original to the next successor.
  if (recovered.kind !== "ready")
    return detach.aborted
      ? { kind: "detached" }
      : repair(
          Error(
            `Native mobile successor ${recovered.kind === "unready" ? "unready" : recovered.reason}.`,
          ),
        );
  const { lease, upstream } = recovered;
  const failures: unknown[] = [];
  let retire: (() => void) | undefined;
  let work: { readonly ok: true } | { readonly ok: false; readonly cause: unknown };
  try {
    retire = holdNativeMobileSuccessorLease(client, pending, lease);
    await input.use(lease, upstream, AbortSignal.any([detach, stop]));
    work = { ok: true };
  } catch (cause) {
    work = { ok: false, cause };
  }
  retire?.();
  let exitRecorded = false;
  if (stop.aborted || !detach.aborted) {
    try {
      const result = await client.stopOriginal(pending);
      // A cancellation fence for a live lease is never evidence that its original child exited.
      if (result.state !== "exited") throw Error("Original native exit is unconfirmed.");
      await input.recordExit(result.exit, new AbortController().signal);
      exitRecorded = true;
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (!exitRecorded) {
    try {
      await client.detach(lease);
    } catch (cause) {
      failures.push(cause);
    }
  }
  try {
    await upstream.release();
  } catch (cause) {
    failures.push(cause);
  }
  if (failures.length || (stop.aborted && !exitRecorded))
    return repair(new AggregateError([...(work.ok ? [] : [work.cause]), ...failures]));
  // A detached original keeps running whatever ended admission: never report it settled.
  if (!exitRecorded) return { kind: "detached" };
  return work.ok
    ? { kind: "exit-recorded" }
    : { kind: "failed", repairRequired: false, cause: work.cause };
}
