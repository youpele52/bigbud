import type { OrchestrationEvent } from "@bigbud/contracts";

type Move = Extract<OrchestrationEvent, { type: "thread.organization-updated" }>;
type State = Move["payload"]["organization"]["state"];

/** Secondary cap, measured only on the server clock (never the client's `Date.now()`). */
export const ORGANIZATION_NOTIFICATION_MAX_AGE_MS = 15_000;

/** Automatic moves committed after this connection went live. `frontier` is the applied
 * sequence recorded when delivery reported `live` (after replay); `null` means not armed, so
 * bootstrap, reconnect replay and recovery never toast. Deliberate moves are confirmed by the
 * issuing client's own command outcome, never from the shared event stream (another window's
 * or user's move, or an Undo restoration, must not toast here).
 */
export function collectOrganizationNotifications(
  events: readonly OrchestrationEvent[],
  frontier: number | null,
): Move[] {
  if (frontier === null) return [];
  return events.filter(
    (event): event is Move =>
      event.type === "thread.organization-updated" &&
      event.payload.automaticMove !== undefined &&
      event.payload.organization.state !== "present" &&
      event.sequence > frontier,
  );
}

/** Drops moves older than the cap relative to the newest server time observed. */
export function recentOrganizationNotifications(
  moves: readonly Move[],
  latestServerAtMs: number,
): Move[] {
  return moves.filter((move) => {
    const at = Date.parse(move.occurredAt);
    return Number.isFinite(at) && latestServerAtMs - at < ORGANIZATION_NOTIFICATION_MAX_AGE_MS;
  });
}

/** One group per destination, most recent first (groups and members by canonical sequence). */
export function groupOrganizationNotifications(moves: readonly Move[]): Move[][] {
  const groups = new Map<State, Move[]>();
  for (const move of [...moves].toSorted((left, right) => right.sequence - left.sequence)) {
    const state = move.payload.organization.state;
    groups.set(state, [...(groups.get(state) ?? []), move]);
  }
  return [...groups.values()];
}

export function manualOrganizationMoveDescription(state: State): string {
  if (state === "present") return "New approvals or questions can move this thread to Needs you.";
  if (state === "needs-you")
    return "If work is still running in 10 minutes and no request remains, this thread will return to Present so you can keep track of it.";
  return "If work is still running in 10 minutes, this thread will return to Present so you can keep track of it. New approvals or questions can move it to Needs you sooner.";
}
