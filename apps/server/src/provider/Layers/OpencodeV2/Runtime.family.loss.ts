import type { V2RuntimeSession } from "./Runtime.types.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import { hasV2RetainedFamily } from "./Runtime.status.ts";
import { runtimeEventBase } from "./Runtime.projection.ts";
import { flushV2FinalEvents, queueV2FinalEvents } from "./Runtime.finalization.ts";

/** Host exit proves neither detached shell death nor completion of a retained create/callback. */
export function hasV2UnconfirmedFamily(owner: V2RuntimeSession) {
  const managed =
    owner.familyPhysicalDrain || owner.familyQualification || owner.familyControl?.nativeReceipt;
  return Boolean(
    (!owner.lease.process.isRunning() && managed && !owner.familyPhysicalDrain?.confirmed()) ||
    owner.session.retainedFamily ||
    hasV2RetainedFamily(owner),
  );
}

/** Keep the durable fence, admission, guard and canonical Stop authority until physical drain is proven. */
export async function retainV2FamilyOnProcessLoss(
  runtime: OpencodeV2Runtime,
  owner: V2RuntimeSession,
) {
  if (!hasV2UnconfirmedFamily(owner)) return false;
  await owner.family?.fence().catch(() => {});
  owner.executionBlocked =
    "V2 native server exited; retained family shell/execution cleanup remains unconfirmed. No rearming.";
  owner.session = {
    ...owner.session,
    status: "error",
    retainedFamily: true,
    lastError: owner.executionBlocked,
  };
  queueV2FinalEvents(owner, [
    {
      ...runtimeEventBase(owner, `family-loss:${owner.lease.generation}`),
      type: "session.state.changed",
      payload: { state: "error", retainedFamily: true, reason: owner.executionBlocked },
    },
  ]);
  // No terminal/exit publication and no resource retirement from host-death evidence.
  owner.lossPending = false;
  await flushV2FinalEvents(owner, (session, event) => runtime.emit(session, event));
  return true;
}
