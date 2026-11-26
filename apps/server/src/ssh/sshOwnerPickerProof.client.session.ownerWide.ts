/**
 * Waiting dispatch on the single-flight owner session. OpenCode lease polls and
 * U24 owner-wide peer requests wait for the in-flight exchange (bounded by its
 * own deadline) instead of refusing; the idle re-check and the dispatch run in
 * one synchronous step. Owner-wide requests name no target: the owner binds none.
 *
 * @module sshOwnerPickerProof.client.session.ownerWide
 */
import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import { EMPTY, type TargetState } from "./sshOwnerPickerProof.client.session.exchange.ts";

/** The empty target scope of an owner-wide request. */
export const OWNER_WIDE: TargetState = { targetId: "", generation: EMPTY };

export interface SessionGate {
  readonly closed: () => boolean;
  readonly active: () => Promise<unknown> | undefined;
  readonly waiting: () => boolean;
}

export function makeWaitingDispatch<T>(
  gate: SessionGate,
  start: (operation: PickerProofOperation, beforeDispatch?: (id: Uint8Array) => void) => Promise<T>,
) {
  return async (
    operation: PickerProofOperation,
    beforeDispatch?: (id: Uint8Array) => void,
  ): Promise<T> => {
    for (;;) {
      const active = gate.active();
      // A closed session dispatches at once so `start` reports it typed.
      if (gate.closed() || (!active && !gate.waiting())) return start(operation, beforeDispatch);
      if (active) await active.catch(() => undefined);
      else await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
}
