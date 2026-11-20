import {
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import { REMOTE_AGENT_IN_FLIGHT_UPDATE_PHASES } from "./remoteAgentInstall.registry.references.ts";

/**
 * Cross-controller fence for Remove agent. Written by CAS before any supervisor is stopped, it
 * makes every registry transition that would start new work on the host fail until the removal
 * finishes or clears it. A fence older than the TTL is ignored, so a crashed removal can never
 * block installs forever; a removal always completes or aborts well inside it.
 */
export const REMOTE_AGENT_REMOVAL_FENCE_TTL_MS = 15 * 60 * 1000;
const FENCE_ID = /^[A-Za-z0-9-]{8,64}$/;

export type RemoteAgentRemovalFence = NonNullable<RemoteAgentRegistry["removal"]>;

export class RemoteAgentRemovalInProgressError extends Error {
  readonly _tag = "RemoteAgentRemovalInProgressError";

  constructor() {
    super("The remote agent is being removed from this host. Retry after the removal finishes.");
    this.name = "RemoteAgentRemovalInProgressError";
  }
}

export function isRemoteAgentRemovalFenceId(id: string): boolean {
  return FENCE_ID.test(id);
}

/** The fence when it is still in force. */
export function activeRemoteAgentRemovalFence(
  state: RemoteAgentRegistry,
  now: number = Date.now(),
): RemoteAgentRemovalFence | null {
  const fence = state.removal;
  if (!fence) return null;
  const age = now - fence.startedAt;
  // A future-dated fence (another controller's skewed clock) still counts, up to one TTL ahead.
  return Math.abs(age) < REMOTE_AGENT_REMOVAL_FENCE_TTL_MS ? fence : null;
}

/** Drops an expired fence without counting a revision; the enclosing write already does. */
export function withoutExpiredRemoteAgentRemovalFence(
  state: RemoteAgentRegistry,
  now: number = Date.now(),
): RemoteAgentRegistry {
  if (!state.removal || activeRemoteAgentRemovalFence(state, now)) return state;
  const { removal: _removal, ...rest } = state;
  return parseRemoteAgentRegistry(JSON.stringify(rest));
}

/** A standalone write that removes an expired fence (resume and cleanup). */
export function dropExpiredRemoteAgentRemovalFence(
  state: RemoteAgentRegistry,
  now: number = Date.now(),
): RemoteAgentRegistry {
  const stripped = withoutExpiredRemoteAgentRemovalFence(state, now);
  return stripped === state
    ? state
    : parseRemoteAgentRegistry(JSON.stringify({ ...stripped, revision: state.revision + 1 }));
}

/** Re-stamps this removal's fence just before deleting; null when the fence was lost. */
export function renewRemoteAgentRemovalFence(
  state: RemoteAgentRegistry,
  id: string,
  now: number = Date.now(),
): RemoteAgentRegistry | null {
  if (state.removal?.id !== id) return null;
  return parseRemoteAgentRegistry(
    JSON.stringify({
      ...state,
      removal: { id, controllerId: state.removal.controllerId, startedAt: now },
      revision: state.revision + 1,
    }),
  );
}

function addedIds<T>(before: readonly T[], next: readonly T[], id: (entry: T) => string): boolean {
  const known = new Set(before.map(id));
  return next.some((entry) => !known.has(id(entry)));
}

/** Refuses any transition that would start new work while another removal holds the fence. */
export function assertRemoteAgentRemovalFenceTransition(
  before: RemoteAgentRegistry,
  next: RemoteAgentRegistry,
  now: number = Date.now(),
): void {
  const fence = activeRemoteAgentRemovalFence(before, now);
  if (!fence) return;
  if (next.removal && next.removal.id !== fence.id) throw new RemoteAgentRemovalInProgressError();
  const inFlight = (state: RemoteAgentRegistry) =>
    state.updates.filter((update) => REMOTE_AGENT_IN_FLIGHT_UPDATE_PHASES.has(update.phase));
  if (
    addedIds(before.stages, next.stages, (entry) => entry.id) ||
    addedIds(before.launches, next.launches, (entry) => entry.id) ||
    addedIds(before.admissions, next.admissions, (entry) => entry.id) ||
    addedIds(before.slotReservations, next.slotReservations, (entry) => entry.id) ||
    addedIds(before.restartReservations, next.restartReservations, (entry) => entry.id) ||
    addedIds(inFlight(before), inFlight(next), (entry) => entry.requestId)
  )
    throw new RemoteAgentRemovalInProgressError();
}

/** Sets this removal's fence; refuses while a different fence is still in force. */
export function withRemoteAgentRemovalFence(
  state: RemoteAgentRegistry,
  fence: RemoteAgentRemovalFence,
  now: number = Date.now(),
): RemoteAgentRegistry {
  if (!isRemoteAgentRemovalFenceId(fence.id)) throw new Error("Invalid removal fence id.");
  const active = activeRemoteAgentRemovalFence(state, now);
  if (active && active.id !== fence.id) throw new RemoteAgentRemovalInProgressError();
  if (active?.id === fence.id) return state;
  return parseRemoteAgentRegistry(
    JSON.stringify({ ...state, removal: fence, revision: state.revision + 1 }),
  );
}

/** Clears the fence only when it is this removal's. */
export function withoutRemoteAgentRemovalFence(
  state: RemoteAgentRegistry,
  id: string,
): RemoteAgentRegistry {
  if (state.removal?.id !== id) return state;
  const { removal: _removal, ...rest } = state;
  return parseRemoteAgentRegistry(JSON.stringify({ ...rest, revision: state.revision + 1 }));
}
