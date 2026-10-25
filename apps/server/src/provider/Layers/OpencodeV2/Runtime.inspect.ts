import type { ThreadId, TurnId } from "@bigbud/contracts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import { correlatedProjection, readV2Messages } from "./Runtime.projection.ts";
import { pendingV2Interactions } from "./Runtime.interactions.ts";
import { v2Request } from "./Client.ts";

/** Inspection shares the ordinary execution/owner queue and never authorizes native cleanup. */
export function inspectV2Turn(runtime: OpencodeV2Runtime, threadId: ThreadId, turnId: TurnId) {
  const session = runtime.get(threadId);
  return runtime.withSession(threadId, async () => {
    await runtime.reconcile(session);
    const observedAt = new Date().toISOString();
    if (!session.row || session.row.turnId !== turnId)
      return { status: "missing" as const, observedAt };
    const projection = correlatedProjection(session, await readV2Messages(session));
    if (projection?.idle && session.row.state === "terminal")
      return {
        status:
          projection.idle.outcome === "succeeded"
            ? ("completed" as const)
            : projection.idle.outcome === "failed"
              ? ("failed" as const)
              : ("unavailable" as const),
        observedAt,
        ...(projection.idle.outcome === "succeeded"
          ? { completionEvidence: { source: "v2.correlated-idle" } }
          : { errorEvidence: { source: "v2.correlated-idle" } }),
      };
    if ((await pendingV2Interactions(session)).length)
      return { status: "waiting-for-user" as const, observedAt };
    const active = await v2Request("session.active", (signal) =>
      session.lease.process.client.session.active({ signal }),
    );
    return {
      status:
        active[session.native.id] && projection ? ("running" as const) : ("unavailable" as const),
      observedAt,
    };
  });
}
