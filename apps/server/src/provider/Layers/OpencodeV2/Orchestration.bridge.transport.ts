import type { Owner, V2ThreadBridge } from "./Orchestration.bridge.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import { decodeV2ThreadCallback } from "./Orchestration.callback.ts";

/** Reply signing uses the exact pending or acknowledged lease of the captured owner. */
export function v2ThreadResponseLease(owners: Iterable<Owner>, value: unknown) {
  const request = decodeV2ThreadCallback(value);
  const owner = [...owners].find(
    (item) =>
      item.enrollment.digest === request.ownerDigest &&
      item.enrollment.options.owner.enrollmentNonce === request.enrollmentNonce,
  );
  if (!owner) throw new Error("V2 callback response owner unavailable.");
  if (request.kind === "proof") {
    owner.enrollment.assertPendingLease(request.leaseRevision, request.leaseExpiresAt);
    return { revision: request.leaseRevision, expiry: request.leaseExpiresAt };
  }
  return owner.enrollment.acknowledgedLease();
}

/** Suspend callback admission/renewal, not the physical work tracked by this enrollment. */
export function suspendV2ThreadOwner(owner: Owner | undefined) {
  if (!owner) return;
  owner.enrollment.pauseRenewal();
  owner.releaseListener?.();
  owner.session.threadToolsReady = false;
}

/** Exact settled enrollment retirement uses the new client; no session cancellation occurs. */
export async function reconnectV2ThreadOwner(
  bridge: V2ThreadBridge,
  owners: Map<string, Owner>,
  session: V2RuntimeSession,
  runtime: OpencodeV2Runtime,
) {
  const owner = owners.get(session.native.id);
  if (owner) {
    if (owner.session !== session || owner.runtime !== runtime)
      throw new Error("V2 canonical reconnect owner mismatch.");
    let reusable = false;
    if (
      owner.enrollment.options.owner.transportGeneration ===
        runtime.options.config.sharedService?.generation &&
      owner.enrollment.options.owner.consentRevision === session.consentPermit?.revision
    ) {
      try {
        owner.enrollment.assertLive();
        reusable = true;
      } catch {
        /* Retain exact retirement evidence. */
      }
    }
    if (reusable) {
      const permit = session.consentPermit;
      const abort = () => suspendV2ThreadOwner(owner);
      permit?.signal.addEventListener("abort", abort, { once: true });
      owner.releaseListener = () => permit?.signal.removeEventListener("abort", abort);
      owner.enrollment.resumeRenewal();
      await bridge.ensure(session);
      return;
    }
    suspendV2ThreadOwner(owner);
    if (owner.active.busyCount() || owner.enrollment.controlCount())
      throw new Error("V2 canonical physical work remains unconfirmed; no reenrollment.");
    owner.enrollment.options.client = session.lease.process.client;
    if (!(await owner.enrollment.detach()))
      throw new Error("V2 canonical retirement proof remains unconfirmed; no reenrollment.");
    clearInterval(owner.timer);
    owner.unregisterActivation?.();
    owners.delete(session.native.id);
    owner.releaseImplementation();
  }
  await bridge.attach(session, runtime);
}
