/**
 * Pure coordinator-side dispatch state machine (P8 WP-8A). The legal moves are the contract's
 * `PeerDispatchTransition` table; events name why a move happens so callers never pick a target
 * state by hand.
 *
 * @module peerDispatch.transition
 */
import {
  PEER_DISPATCH_TERMINAL_STATES,
  type PeerDispatchState,
  type PeerDispatchTransition,
} from "@bigbud/contracts/server/remotePeer.ts";

export type PeerDispatchEvent =
  /** The pending record is durable and the delegate request is about to go out. */
  | "send-started"
  /** The worker receipt (send reply or status probe) names the child. */
  | "worker-accepted"
  /** The coordinator began following the accepted child. */
  | "follow-started"
  | "child-completed"
  | "child-failed"
  /** Refused before sending, or the worker definitively refused this dispatch identity. */
  | "rejected"
  | "cancel-requested"
  | "cancel-confirmed";

export const PEER_DISPATCH_EVENTS = [
  "send-started",
  "worker-accepted",
  "follow-started",
  "child-completed",
  "child-failed",
  "rejected",
  "cancel-requested",
  "cancel-confirmed",
] as const satisfies ReadonlyArray<PeerDispatchEvent>;

const EDGES: Readonly<
  Record<PeerDispatchState, Partial<Record<PeerDispatchEvent, PeerDispatchState>>>
> = {
  pending: {
    "send-started": "sent-uncertain",
    rejected: "failed",
    "cancel-requested": "cancelled",
  },
  "sent-uncertain": {
    "worker-accepted": "accepted",
    rejected: "failed",
    "cancel-requested": "cancel-pending",
  },
  accepted: {
    "follow-started": "following",
    "child-completed": "completed",
    "child-failed": "failed",
    "cancel-requested": "cancel-pending",
  },
  following: {
    "child-completed": "completed",
    "child-failed": "failed",
    "cancel-requested": "cancel-pending",
  },
  "cancel-pending": {
    "cancel-confirmed": "cancelled",
    "child-completed": "completed",
    "child-failed": "failed",
  },
  completed: {},
  failed: {},
  cancelled: {},
};

export type PeerDispatchTransitionResult =
  | { readonly _tag: "moved"; readonly from: PeerDispatchState; readonly to: PeerDispatchState }
  | {
      readonly _tag: "illegal";
      readonly from: PeerDispatchState;
      readonly event: PeerDispatchEvent;
    };

/** Applies one event; anything outside the table is reported as illegal, never coerced. */
export function applyPeerDispatchEvent(
  from: PeerDispatchState,
  event: PeerDispatchEvent,
): PeerDispatchTransitionResult {
  const to = EDGES[from][event];
  return to === undefined ? { _tag: "illegal", from, event } : { _tag: "moved", from, to };
}

export const peerDispatchTransitionKey = (from: PeerDispatchState, to: PeerDispatchState): string =>
  `${from}->${to}`;

const LEGAL = new Set<string>(
  Object.entries(EDGES).flatMap(([from, events]) =>
    Object.values(events).map((to) =>
      peerDispatchTransitionKey(from as PeerDispatchState, to as PeerDispatchState),
    ),
  ),
);

/** True only for a move listed in the contract table; same-state "moves" are never transitions. */
export function isLegalPeerDispatchTransition(
  from: PeerDispatchState,
  to: PeerDispatchState,
): boolean {
  return LEGAL.has(peerDispatchTransitionKey(from, to));
}

/** Every legal transition key, for consistency checks against the contract enum. */
export function listPeerDispatchTransitions(): ReadonlyArray<PeerDispatchTransition> {
  return [...LEGAL] as ReadonlyArray<PeerDispatchTransition>;
}

const TERMINAL = new Set<PeerDispatchState>(PEER_DISPATCH_TERMINAL_STATES);

export const isTerminalPeerDispatchState = (state: PeerDispatchState): boolean =>
  TERMINAL.has(state);
