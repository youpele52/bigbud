import { createHash, randomUUID } from "node:crypto";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { runtimeEventBase } from "./Runtime.projection.ts";

/** Publish recovery state to normal orchestration/UI, without synthesizing an execution outcome. */
export async function v2RuntimeStatus(
  runtime: OpencodeV2Runtime,
  session: V2RuntimeSession,
  state: "error" | "running" | "waiting" | "ready",
  reason?: string,
) {
  if (session.stopped) return;
  const signature = createHash("sha256")
    .update(JSON.stringify([state, reason, session.row?.turnId]))
    .digest("hex");
  if (session.runtimeState?.signature === signature) return;
  const sequence = (session.runtimeState?.sequence ?? 0) + 1;
  session.session = {
    ...session.session,
    status: state === "waiting" ? "running" : state,
    lastError: state === "error" ? reason : undefined,
    updatedAt: new Date().toISOString(),
  };
  await runtime.emit(session, {
    // A recovered owner must not collide with an earlier owner's persisted state transition.
    ...runtimeEventBase(session, `state:${session.epoch}:${sequence}:${randomUUID()}`),
    type: "session.state.changed",
    payload: { state, ...(reason ? { reason } : {}) },
  });
  session.runtimeState = { signature, sequence };
}
