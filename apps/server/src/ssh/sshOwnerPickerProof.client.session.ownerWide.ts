/**
 * Waiting dispatch on the single-flight owner session. OpenCode lease polls and
 * U24 owner-wide peer requests wait for the in-flight exchange (bounded by its
 * own deadline) instead of refusing; the idle re-check and the dispatch run in
 * one synchronous step. Owner-wide requests name no target: the owner binds none.
 *
 * @module sshOwnerPickerProof.client.session.ownerWide
 */
import type { PickerProofOperation } from "./sshOwnerPickerProof.codec.ts";
import type { Outcome } from "./sshOwnerPickerProof.codec.outcome.ts";
import type { OwnerShutdownReport } from "./sshOwnerPickerProof.codec.ownerShutdown.ts";
import { invalid } from "./sshOwnerPickerProof.codec.wire.ts";
import { EMPTY, type TargetState } from "./sshOwnerPickerProof.client.session.exchange.ts";

/**
 * A fresh owner-wide scope per request. The exchange records the generation a reply
 * reports on its scope; an owner-wide reply names no target, so sharing one scope let
 * an earlier reply's at-rest generation fail a later owner-wide request as a protocol
 * violation.
 */
export const ownerWideScope = (): TargetState => ({ targetId: "", generation: EMPTY });

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

/** Drain-time owner shutdown (Request 194): accepts only the shutdown report. */
export const makeOwnerShutdown =
  (execute: (operation: PickerProofOperation) => Promise<Outcome>) =>
  async (): Promise<OwnerShutdownReport> => {
    const outcome = await execute({ kind: "ownerShutdown" });
    return outcome.kind === "ownerShutdown" ? outcome.value : invalid();
  };
