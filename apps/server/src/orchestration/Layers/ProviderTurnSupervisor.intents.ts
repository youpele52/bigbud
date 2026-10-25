/**
 * Paged walks over recovery intents. A backend start or a sleep epoch must reach every
 * candidate, so these never stop at one page. Each page is one bounded, indexed query.
 *
 * A visit may update the intent it is given. An updated row can show up again on a later page
 * of the `updatedAt` walk; visitors skip rows they already moved, so the walk still ends.
 *
 * @module ProviderTurnSupervisor.intents
 */
import type { ThreadRecoveryStatus } from "@bigbud/contracts/orchestration/orchestration.recovery.ts";
import { Effect } from "effect";

import type { PersistenceSqlError } from "../../persistence/Errors.ts";
import type { ThreadRecoveryIntent } from "../../persistence/Services/ThreadRecoveryIntents.ts";
import type { RecoveryContext } from "./ProviderTurnSupervisor.state.ts";

export const RECOVERY_INTENT_PAGE_SIZE = 200;

type Visit<E> = (intent: ThreadRecoveryIntent) => Effect.Effect<void, E>;

/** Every active intent (optionally of some statuses), oldest update first. */
export const forEachActiveIntent = Effect.fn("forEachActiveRecoveryIntent")(function* <E>(
  ctx: RecoveryContext,
  statuses: ReadonlyArray<ThreadRecoveryStatus> | undefined,
  visit: Visit<E>,
): Effect.fn.Return<void, E | PersistenceSqlError> {
  let last: ThreadRecoveryIntent | undefined;
  for (;;) {
    const page = yield* ctx.intents.listActive({
      ...(statuses === undefined ? {} : { statuses }),
      limit: RECOVERY_INTENT_PAGE_SIZE,
      ...(last === undefined
        ? {}
        : { after: { threadId: last.threadId, messageId: last.messageId, at: last.updatedAt } }),
    });
    for (const intent of page) yield* visit(intent);
    if (page.length < RECOVERY_INTENT_PAGE_SIZE) return;
    last = page.at(-1);
  }
});

/** Every intent a post-wake restart left uncertain, oldest accepted first. */
export const forEachUncertainAfterRestart = Effect.fn("forEachUncertainRecoveryIntent")(function* <
  E,
>(ctx: RecoveryContext, visit: Visit<E>): Effect.fn.Return<void, E | PersistenceSqlError> {
  let last: ThreadRecoveryIntent | undefined;
  for (;;) {
    const page = yield* ctx.intents.listUncertainAfterRestart({
      limit: RECOVERY_INTENT_PAGE_SIZE,
      ...(last === undefined
        ? {}
        : { after: { threadId: last.threadId, messageId: last.messageId, at: last.createdAt } }),
    });
    for (const intent of page) yield* visit(intent);
    if (page.length < RECOVERY_INTENT_PAGE_SIZE) return;
    last = page.at(-1);
  }
});
