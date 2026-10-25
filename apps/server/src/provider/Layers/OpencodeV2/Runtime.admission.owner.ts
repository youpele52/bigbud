import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { currentV2RequestContext } from "./Client.guard.ts";
import { logV2SettlementDiagnostic } from "./Runtime.settlement.log.ts";

/** Capture one operation's exact authority, never the owner's later replacement epoch/generation. */
export function captureV2AdmissionOwner(runtime: OpencodeV2Runtime, owner: V2RuntimeSession) {
  const epoch = owner.epoch,
    dirty = owner.dirtyGeneration;
  const hub = owner.lease.hub.generation(owner.native.id),
    process = owner.lease.generation;
  const nativeId = owner.native.id,
    context = currentV2RequestContext();
  return () => {
    if (owner.activation?.token) owner.activation.gate.assertReservation(owner.activation.token);
    context?.permit.assertCurrent();
    owner.consentPermit?.assertCurrent();
    if (
      runtime.sessions.get(owner.threadId) !== owner ||
      owner.stopped ||
      owner.epoch !== epoch ||
      owner.dirtyGeneration !== dirty ||
      owner.lease.hub.generation(nativeId) !== hub ||
      owner.lease.generation !== process ||
      owner.native.id !== nativeId ||
      !owner.lease.process.isRunning()
    ) {
      const reason =
        owner.dirtyGeneration !== dirty
          ? "dirty generation"
          : owner.lease.hub.generation(nativeId) !== hub
            ? "hub generation"
            : owner.epoch !== epoch
              ? "epoch"
              : "owner/process";
      logV2SettlementDiagnostic("OpenCode v2 admission owner rejected", {
        threadId: owner.threadId,
        nativeSessionId: nativeId,
        reason,
      });
      throw new Error(
        `V2 admission owner/generation unconfirmed (${reason}); no automatic resend.`,
      );
    }
  };
}

/** A routine queued poll is not a source gap and must not preempt an active admission. */
export async function withV2AdmissionOperation<T>(
  owner: V2RuntimeSession,
  run: () => Promise<T>,
): Promise<T> {
  owner.admissionInFlight = true;
  try {
    return await run();
  } finally {
    owner.admissionInFlight = false;
  }
}
