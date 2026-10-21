import { createHash } from "node:crypto";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import { settleV2RuntimeReservation } from "./Runtime.activation.ts";
import { needsV2FinalRepair } from "./Runtime.finalization.ts";
import { v2RuntimeStatus } from "./Runtime.status.ts";
import { captureV2OperationAuthority } from "./Client.guard.ts";
import { v2SettlementHoldCounts, type V2SettlementHoldReason } from "./Runtime.activation.hold.ts";
import { logV2SettlementDiagnostic } from "./Runtime.settlement.log.ts";

type Pending = {
  token: NonNullable<NonNullable<V2RuntimeSession["activation"]>["token"]>;
  since: number;
  next: number;
  delay: number;
  reported: boolean;
  /** Last observed hold reason; logged once per change, shown in the 30-second status. */
  reason?: V2SettlementHoldReason | undefined;
};
const pending = new WeakMap<V2RuntimeSession, Pending>();
const familyPoll = new WeakMap<V2RuntimeSession, number>();

/** Terminal delivery is not physical settlement; keep its exact token observable until proved drained. */
export function hasV2RetainedReservation(owner: V2RuntimeSession) {
  return Boolean(
    !owner.stopped &&
    owner.activation?.token &&
    (!owner.row || (owner.row.state === "terminal" && owner.terminalDelivered)),
  );
}

function observation(owner: V2RuntimeSession, now: number) {
  const token = owner.activation!.token!;
  let state = pending.get(owner);
  if (state?.token !== token) {
    state = { token, since: now, next: now, delay: 1000, reported: false };
    pending.set(owner, state);
  }
  return state;
}

/** Use the existing serialized repair queue, with at most one retained-owner check per 30s at steady state. */
export function shouldPollV2Runtime(owner: V2RuntimeSession, now = Date.now()) {
  if (owner.admissionInFlight || owner.repairQueued) return false;
  if (owner.stopped) return needsV2FinalRepair(owner);
  if (
    owner.family?.live ||
    owner.family?.persistenceUncertain ||
    owner.familyControl?.busyCount?.() ||
    owner.session.retainedFamily
  )
    return true;
  // Completed foreground children remain enrolled and can receive a qualified newer
  // revision. Bounded repair must not depend on the live-child hint index retaining them.
  if (
    owner.family?.children.length &&
    !owner.family.isFenced &&
    now >= (familyPoll.get(owner) ?? 0)
  ) {
    familyPoll.set(owner, now + 30000);
    return true;
  }
  if (
    needsV2FinalRepair(owner) ||
    (owner.row &&
      (owner.row.state !== "terminal" ||
        !owner.terminalDelivered ||
        owner.lease.hub.isDirty(owner.native.id)))
  )
    return true;
  if (!hasV2RetainedReservation(owner)) return false;
  const state = observation(owner, now);
  if (now < state.next) return false;
  state.next = now + state.delay;
  state.delay = Math.min(30000, state.delay * 2);
  return true;
}

/** Settlement-only retries never reread/re-emit already delivered history or dispatch a prompt. */
export async function repairV2RetainedReservation(
  runtime: OpencodeV2Runtime,
  owner: V2RuntimeSession,
) {
  const state = observation(owner, Date.now());
  const authority = captureV2OperationAuthority(),
    activation = owner.activation;
  const validate = () => {
    authority.assertCurrent();
    owner.consentPermit?.assertCurrent();
    if (
      owner.stopped ||
      runtime.sessions.get(owner.threadId) !== owner ||
      owner.activation !== activation ||
      (owner.activation?.token && owner.activation.token !== state.token)
    )
      throw new Error("V2 retained settlement owner changed.");
  };
  const report = async () => {
    validate();
    if (owner.activation?.token && Date.now() - state.since >= 30000) {
      const hold = state.reason ? ` (hold: ${state.reason})` : "";
      await v2RuntimeStatus(
        runtime,
        owner,
        "error",
        `Previous execution settlement remains unconfirmed${hold}. New messages are blocked; no automatic resend.`,
        validate,
      );
      state.reported = true;
    }
  };
  validate();
  try {
    const reason = await settleV2RuntimeReservation(runtime, owner);
    if (reason && reason !== state.reason) logV2SettlementHold(runtime, owner, reason);
    state.reason = reason;
  } catch (error) {
    await report();
    throw error;
  }
  validate();
  if (!owner.activation?.token) {
    if (state.reported) await v2RuntimeStatus(runtime, owner, "ready", undefined, validate);
    pending.delete(owner);
  } else await report();
}

/** One redacted line per hold-reason change: identifiers, reason, counts and gate states only. */
export function logV2SettlementHold(
  runtime: OpencodeV2Runtime,
  owner: V2RuntimeSession,
  reason: V2SettlementHoldReason,
) {
  const gate = owner.activation?.gate.snapshot();
  logV2SettlementDiagnostic("OpenCode v2 execution settlement held", {
    threadId: owner.threadId,
    nativeSessionId: owner.native.id,
    reason,
    ...v2SettlementHoldCounts(runtime, owner),
    ...(gate
      ? {
          gateClosed: gate.closed,
          gateEpoch: gate.epoch,
          gateOperations: gate.operations.map(({ key, state, physicalSettled }) => ({
            key: createHash("sha256").update(key).digest("hex").slice(0, 12),
            state,
            physicalSettled,
          })),
        }
      : {}),
  });
}
