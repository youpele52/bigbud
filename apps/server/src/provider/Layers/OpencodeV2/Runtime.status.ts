import { createHash, randomUUID } from "node:crypto";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { runtimeEventBase } from "./Runtime.projection.ts";

export function hasV2RetainedFamily(owner: V2RuntimeSession) {
  return Boolean(
    owner.family?.live || owner.family?.persistenceUncertain || owner.familyControl?.busyCount?.(),
  );
}

/** Publish recovery state to normal orchestration/UI, without synthesizing an execution outcome. */
export async function v2RuntimeStatus(
  runtime: OpencodeV2Runtime,
  session: V2RuntimeSession,
  state: "error" | "running" | "waiting" | "ready",
  reason?: string,
  validate?: () => void,
) {
  if (session.stopped) return;
  session.consentPermit?.assertCurrent();
  validate?.();
  const retainedFamily = hasV2RetainedFamily(session);
  const signature = createHash("sha256")
    .update(JSON.stringify([state, reason, session.row?.turnId, retainedFamily]))
    .digest("hex");
  if (session.runtimeState?.signature === signature) return;
  const sequence = (session.runtimeState?.sequence ?? 0) + 1;
  await runtime.emit(
    session,
    {
      // A recovered owner must not collide with an earlier owner's persisted state transition.
      ...runtimeEventBase(session, `state:${session.epoch}:${sequence}:${randomUUID()}`),
      type: "session.state.changed",
      payload: { state, retainedFamily, ...(reason ? { reason } : {}) },
    },
    validate,
  );
  validate?.();
  session.session = {
    ...session.session,
    status: state === "waiting" ? "running" : state,
    retainedFamily,
    lastError: state === "error" ? reason : undefined,
    updatedAt: new Date().toISOString(),
  };
  session.runtimeState = { signature, sequence, state };
}
