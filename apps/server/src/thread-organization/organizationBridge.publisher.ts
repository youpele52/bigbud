import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrganizationResync } from "./organizationLifecycle.ts";
import type { OrganizationObservation } from "./organizationObservation.ts";
import type { OrganizationFrame, OrganizationRow } from "./organizationProtocol.ts";

type Epoch = { backendNonce: string; generation: number };
type Observed =
  | { status: "stale" }
  | { status: "missing"; frontier: number; row: undefined }
  | { status: "unchanged" | "applied"; frontier: number; row: OrganizationRow };

export interface OrganizationPublisherState {
  /** Highest fact sequence whose frame was fully written to the native pipe. */
  sequence: number;
  /** Monotonic canonical frontier attached to every published fact. */
  frontier: number;
}

/** Serializes observation → fact-frame publication. Observations never schedule. A stale
 * observation (a canonical command raced the read) is re-marked and retried, never fatal.
 * `state.sequence` only advances after the write resolves, so an independent heartbeat can
 * never claim a fact sequence Rust has not been sent.
 */
export function makeOrganizationPublisher<E, R>(input: {
  sql: SqlClient.SqlClient;
  epoch: Epoch;
  /** Current shared grace; settings changes apply without a resnapshot. */
  graceMs: () => number;
  rows: Map<string, OrganizationRow>;
  observations: OrganizationObservation;
  observe: (threadId: string, graceMs: number) => Effect.Effect<Observed, E, R>;
  send: (frame: OrganizationFrame) => Effect.Effect<void, Error>;
  initial: OrganizationPublisherState;
}) {
  const { epoch, rows } = input;
  const lock = Semaphore.makeUnsafe(1);
  const state: OrganizationPublisherState = { ...input.initial };
  const publish = (row: OrganizationRow, deleted: boolean) =>
    Effect.gen(function* () {
      const sequence = state.sequence + 1;
      yield* input.send({
        ...epoch,
        type: "fact",
        value: { sequence, sourceFrontier: state.frontier, row, deleted },
      });
      state.sequence = sequence;
    });
  const refresh = (threadId: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const observed = yield* input.observe(threadId, input.graceMs());
        if (observed.status === "stale") {
          input.observations.mark(threadId);
          return;
        }
        state.frontier = Math.max(state.frontier, observed.frontier);
        if (observed.row) {
          const old = rows.get(threadId);
          if (old && JSON.stringify(old) === JSON.stringify(observed.row)) return;
          rows.set(threadId, observed.row);
          return yield* publish(observed.row, false);
        }
        const old = rows.get(threadId);
        if (!old) return;
        const [tombstone] = yield* input.sql<{
          fact_version: number;
          deleted: number;
        }>`SELECT fact_version, deleted FROM thread_organization_runtime_threads WHERE thread_id = ${threadId}`;
        // A projection row vanishing without a canonical tombstone (rebuild/restore) is not a
        // native fault; a fresh snapshot is the only safe interpretation.
        if (!tombstone || tombstone.deleted !== 1)
          return yield* Effect.fail(
            new OrganizationResync("organisation thread disappearance requires resync"),
          );
        rows.delete(threadId);
        yield* publish({ ...old, factVersion: tombstone.fact_version }, true);
      }),
    );
  return { state, refresh };
}
