import { describe, expect, it } from "vitest";
import {
  PeerDispatchState,
  PeerDispatchTransition,
  type PeerDispatchState as State,
} from "@bigbud/contracts/server/remotePeer.ts";

import {
  PEER_DISPATCH_EVENTS,
  applyPeerDispatchEvent,
  isLegalPeerDispatchTransition,
  isTerminalPeerDispatchState,
  listPeerDispatchTransitions,
  type PeerDispatchEvent,
} from "./peerDispatch.transition.ts";

/** The full expected table: every (state, event) pair not listed here must be illegal. */
const EXPECTED: Record<State, Partial<Record<PeerDispatchEvent, State>>> = {
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

describe("applyPeerDispatchEvent", () => {
  for (const from of PeerDispatchState.literals)
    for (const event of PEER_DISPATCH_EVENTS)
      it(`${from} + ${event}`, () => {
        const to = EXPECTED[from][event];
        expect(applyPeerDispatchEvent(from, event)).toEqual(
          to === undefined ? { _tag: "illegal", from, event } : { _tag: "moved", from, to },
        );
      });
});

describe("transition table", () => {
  it("matches the contract enum exactly", () => {
    expect([...listPeerDispatchTransitions()].toSorted()).toEqual(
      [...PeerDispatchTransition.literals].toSorted(),
    );
  });

  it("rejects every state pair outside the table, including self moves", () => {
    const legal = new Set<string>(PeerDispatchTransition.literals);
    for (const from of PeerDispatchState.literals)
      for (const to of PeerDispatchState.literals)
        expect(isLegalPeerDispatchTransition(from, to)).toBe(legal.has(`${from}->${to}`));
  });

  it("never relaunches: nothing re-enters pending or sent-uncertain after a send", () => {
    for (const from of PeerDispatchState.literals) {
      expect(isLegalPeerDispatchTransition(from, "pending")).toBe(false);
      if (from !== "pending")
        expect(isLegalPeerDispatchTransition(from, "sent-uncertain")).toBe(false);
    }
  });

  it("keeps cancel intent durable and terminal states final", () => {
    for (const to of ["sent-uncertain", "accepted", "following", "pending"] as const)
      expect(isLegalPeerDispatchTransition("cancel-pending", to)).toBe(false);
    for (const terminal of ["completed", "failed", "cancelled"] as const) {
      expect(isTerminalPeerDispatchState(terminal)).toBe(true);
      for (const event of PEER_DISPATCH_EVENTS)
        expect(applyPeerDispatchEvent(terminal, event)._tag).toBe("illegal");
    }
    expect(isTerminalPeerDispatchState("cancel-pending")).toBe(false);
  });
});
