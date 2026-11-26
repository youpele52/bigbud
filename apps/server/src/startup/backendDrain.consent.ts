import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import type { LegacyDrainChoice, LegacyDrainPane } from "../ssh/sshLegacyDrain.ts";
import type { BackendDrainStatus } from "./backendDrain.protocol.ts";

/**
 * One pending UI consent. The backend publishes exactly one snapshot; the UI
 * returns exactly one decision. Late or duplicate decisions are refused, and a
 * timeout cancels the drain without touching panes or writing a marker.
 *
 * @module backendDrain.consent
 */
export type BackendDrainDecision =
  | { readonly kind: "cancel" }
  | { readonly kind: "proceed"; readonly choice: LegacyDrainChoice };

export interface PendingBackendDrain {
  readonly drainId: string;
  readonly panes: ReadonlyArray<LegacyDrainPane>;
  readonly deadlineAt: number;
}

type Pending = PendingBackendDrain & {
  readonly decision: Deferred.Deferred<BackendDrainDecision>;
  settled: boolean;
};

let pending: Pending | undefined;
let lastDecidedDrainId: string | undefined;
const listeners = new Set<(pending: PendingBackendDrain | undefined) => void>();

const publish = (value: PendingBackendDrain | undefined) => {
  for (const listener of listeners) listener(value);
};

export function subscribeBackendDrainConsent(
  listener: (pending: PendingBackendDrain | undefined) => void,
): () => void {
  listeners.add(listener);
  listener(pending ? snapshot(pending) : undefined);
  return () => listeners.delete(listener);
}

export function hasBackendDrainUi(): boolean {
  return listeners.size > 0;
}

export function wasBackendDrainDecided(drainId: string): boolean {
  return lastDecidedDrainId === drainId;
}

export function pendingBackendDrain(): PendingBackendDrain | undefined {
  return pending ? snapshot(pending) : undefined;
}

const snapshot = (value: Pending): PendingBackendDrain => ({
  drainId: value.drainId,
  panes: value.panes,
  deadlineAt: value.deadlineAt,
});

/**
 * Publishes the pane list and waits for exactly one decision. With no UI
 * subscriber this returns `consent-required` immediately.
 */
export const requestBackendDrainConsent = Effect.fn("requestBackendDrainConsent")(
  function* (input: {
    readonly panes: ReadonlyArray<LegacyDrainPane>;
    readonly timeoutMs: number;
    readonly drainId: string;
  }) {
    if (listeners.size === 0) return { kind: "consent-required" } as { kind: "consent-required" };
    if (pending) return { kind: "busy" } as const;
    const decision = yield* Deferred.make<BackendDrainDecision>();
    const current: Pending = {
      drainId: input.drainId,
      panes: input.panes,
      deadlineAt: Date.now() + input.timeoutMs,
      decision,
      settled: false,
    };
    pending = current;
    publish(snapshot(current));
    const result = yield* Deferred.await(decision).pipe(
      Effect.timeoutOrElse({
        duration: input.timeoutMs,
        orElse: () => Effect.succeed({ kind: "cancel" } as const),
      }),
    );
    current.settled = true;
    pending = undefined;
    publish(undefined);
    return result.kind === "cancel"
      ? ({ kind: "cancelled" } as const)
      : ({ kind: "proceed", choice: result.choice } as const);
  },
);

/** One decision per drain; a late or unknown id is refused. */
export function decideBackendDrain(
  drainId: string,
  decision: BackendDrainDecision,
): BackendDrainStatus | "refused" {
  if (!pending || pending.drainId !== drainId || pending.settled) return "refused";
  pending.settled = true;
  lastDecidedDrainId = drainId;
  Deferred.doneUnsafe(pending.decision, Effect.succeed(decision));
  return decision.kind === "cancel" ? "cancelled" : "drained";
}
