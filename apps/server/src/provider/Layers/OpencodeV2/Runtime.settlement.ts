import type { V2RuntimeSession } from "./Runtime.types.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import { settleV2RuntimeReservation } from "./Runtime.activation.ts";
import { needsV2FinalRepair } from "./Runtime.finalization.ts";
import { v2RuntimeStatus } from "./Runtime.status.ts";
import { captureV2OperationAuthority } from "./Client.guard.ts";

type Pending = {
  token: NonNullable<NonNullable<V2RuntimeSession["activation"]>["token"]>;
  since: number;
  next: number;
  delay: number;
  reported: boolean;
};
const pending = new WeakMap<V2RuntimeSession, Pending>();

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
      await v2RuntimeStatus(
        runtime,
        owner,
        "error",
        "Previous execution settlement remains unconfirmed. New messages are blocked; no automatic resend.",
        validate,
      );
      state.reported = true;
    }
  };
  validate();
  try {
    await settleV2RuntimeReservation(runtime, owner);
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
