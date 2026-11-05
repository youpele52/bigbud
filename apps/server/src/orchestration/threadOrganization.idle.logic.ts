/**
 * Inyosira idle cleanup rules. Idle only moves a thread whose execution is confirmed quiescent;
 * anything running, queued, held, starting, or recovering keeps it in Present.
 */
import type { OrchestrationThread } from "@bigbud/contracts";
import type { ThreadOrganization } from "@bigbud/contracts/orchestration/orchestration.organization.ts";

const ACTIVE_SESSION_STATUSES = new Set(["starting", "running"]);

type QuiescenceFacts = Pick<
  OrchestrationThread,
  | "session"
  | "latestTurn"
  | "queuedPrompts"
  | "pendingTurnStart"
  | "pendingInterruptFlushIntent"
  | "pendingTurnControlOperation"
  | "queueHold"
  | "recovery"
>;

/**
 * The read-model half of the idle gates. The candidate query applies the same gates plus the
 * ones the read model does not carry in full (pending approvals and questions, delegations,
 * watches), so the decider re-check and the query agree.
 */
export function isThreadQuiescent(thread: QuiescenceFacts): boolean {
  if (thread.session && ACTIVE_SESSION_STATUSES.has(thread.session.status)) return false;
  if (thread.latestTurn?.state === "running") return false;
  if ((thread.queuedPrompts ?? []).length > 0) return false;
  if (thread.pendingTurnStart) return false;
  if (thread.pendingInterruptFlushIntent) return false;
  if (thread.pendingTurnControlOperation) return false;
  if (thread.queueHold) return false;
  return !thread.recovery;
}

/** The idle move, or null when the thread changed since the candidate was read. */
export function organizationAfterIdle(
  current: ThreadOrganization,
  input: {
    readonly expectedRevision: number;
    readonly fromState: "present" | "later";
    readonly destination: "done" | "later";
    readonly occurredAt: string;
  },
): ThreadOrganization | null {
  if (current.state !== input.fromState || current.snooze !== null) return null;
  if (input.fromState === input.destination) return null;
  if (current.revision !== input.expectedRevision) return null;
  return {
    state: input.destination,
    revision: current.revision + 1,
    changedAt: input.occurredAt,
    snooze: null,
  };
}
