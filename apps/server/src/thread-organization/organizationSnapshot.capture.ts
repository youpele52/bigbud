import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { type OrganizationOwnerFacts } from "./organizationFacts.build.ts";
import {
  countOrganizationThreads,
  readOrganizationFrontier,
  readOrganizationThreadIds,
} from "./organizationFacts.query.ts";
import { makeOrganizationFactStore } from "./organizationFacts.store.ts";
import { OrganizationLimit, OrganizationResync } from "./organizationLifecycle.ts";
import { ORGANIZATION_LIMITS, type OrganizationRow } from "./organizationProtocol.ts";

/** Capture wall budget, scaled to the membership count. The 5k/10k synthetic fixture measures
 * about 0.6ms per row; 10ms per row leaves headroom for real history-heavy databases. Each
 * consecutive overrun doubles the budget up to the cap, so a slow but finite database still
 * activates; an overrun at the cap is a terminal limit instead of an endless heavy loop.
 */
export const ORGANIZATION_CAPTURE_BUDGET = {
  minMs: 120_000,
  perRowMs: 10,
  maxMs: 1_800_000,
} as const;
const STALE_RETRIES = 3;

export function organizationCaptureBudgetMs(members: number, overruns: number) {
  const B = ORGANIZATION_CAPTURE_BUDGET;
  const base = Math.max(B.minMs, members * B.perRowMs);
  return Math.min(B.maxMs, base * 2 ** Math.min(overruns, 16));
}

/** Paged capture: every row is observed in its own short write transaction, so manual moves,
 * chat and other canonical commands interleave instead of waiting for the whole table. The
 * live capture must already be open: any thread changed after its row was read is marked dirty
 * and refreshed with a higher fact sequence after activation, so per-row frontiers need not
 * match. An over-budget or contended capture is a routine resync, never a published snapshot.
 */
export function makeOrganizationSnapshotCapture<E>(input: {
  sql: SqlClient.SqlClient;
  owners: (id: string) => Effect.Effect<OrganizationOwnerFacts, E>;
  now?: () => number;
  /** Fixed budget for tests; production sizes it from the membership count. */
  budgetMs?: number;
}) {
  const now = input.now ?? Date.now;
  const store = makeOrganizationFactStore({ sql: input.sql, owners: input.owners, now });
  let overruns = 0;
  return Effect.fn("OrganizationSnapshot.capture")(function* (graceMs: number) {
    const started = now();
    const [initial] = yield* readOrganizationFrontier(input.sql);
    if (!initial || initial.mismatch !== 0 || initial.projectorCount === 0)
      return yield* Effect.fail(new OrganizationResync("organisation projections are catching up"));
    const [membership] = yield* countOrganizationThreads(input.sql);
    const members = membership?.count ?? 0;
    if (members > ORGANIZATION_LIMITS.liveRows)
      return yield* Effect.fail(
        new OrganizationLimit(
          "thread-limit",
          `${members} threads exceed the ${ORGANIZATION_LIMITS.liveRows} thread limit`,
        ),
      );
    const budgetMs = input.budgetMs ?? organizationCaptureBudgetMs(members, overruns);
    let frontier = initial.frontier;
    const rows: OrganizationRow[] = [];
    let after: string | undefined;
    while (true) {
      const page = yield* readOrganizationThreadIds(input.sql, after, ORGANIZATION_LIMITS.pageRows);
      for (const { threadId } of page) {
        if (now() - started > budgetMs) {
          if (budgetMs >= ORGANIZATION_CAPTURE_BUDGET.maxMs)
            return yield* Effect.fail(
              new OrganizationLimit("capture-time", "the snapshot exceeded its largest budget"),
            );
          overruns += 1;
          return yield* Effect.fail(
            new OrganizationResync("organisation snapshot capture exceeded its budget"),
          );
        }
        let observed = yield* store.observe(threadId, graceMs);
        for (let retry = 0; observed.status === "stale" && retry < STALE_RETRIES; retry++)
          observed = yield* store.observe(threadId, graceMs);
        if (observed.status === "stale")
          return yield* Effect.fail(new OrganizationResync("organisation snapshot contention"));
        // Deleted between membership and fact reads: the captured deletion covers it.
        if (!observed.row) continue;
        frontier = Math.max(frontier, observed.frontier);
        rows.push(observed.row);
        // Threads created during capture can push past the counted membership.
        if (rows.length > ORGANIZATION_LIMITS.liveRows)
          return yield* Effect.fail(
            new OrganizationLimit("thread-limit", "threads exceed the live row limit"),
          );
      }
      if (page.length < ORGANIZATION_LIMITS.pageRows) break;
      after = page.at(-1)?.threadId;
    }
    overruns = 0;
    return { rows, frontier };
  });
}
