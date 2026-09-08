import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { OrchestrationDeliveryRecoveryReason } from "@bigbud/contracts/orchestration/orchestration.delivery.ts";
import type { OrchestrationReplayEventsResult } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";

import { DESKTOP_SUPERVISOR_REPLAY_BUFFER_CAPACITY } from "./desktopSupervisorConfig.ts";

const REPLAY_PAGE_LIMIT = 1_000;

export type ReplayInspection = {
  readonly replay: OrchestrationReplayEventsResult;
  readonly recoveryReason?: OrchestrationDeliveryRecoveryReason;
};

export async function inspectCompleteReplay(input: {
  readonly acknowledgedSequence: number;
  readonly readReplay: (
    fromSequenceExclusive: number,
    limit?: number,
  ) => Promise<OrchestrationReplayEventsResult>;
}): Promise<ReplayInspection> {
  const events: OrchestrationEvent[] = [];
  let cursor = input.acknowledgedSequence;
  for (;;) {
    const page = await input.readReplay(cursor, REPLAY_PAGE_LIMIT);
    if (page.availability === "gap") {
      return { replay: { ...page, events: [] }, recoveryReason: "replay_unavailable" };
    }
    if (events.length + page.events.length > DESKTOP_SUPERVISOR_REPLAY_BUFFER_CAPACITY) {
      return {
        replay: { ...page, complete: false, events: [] },
        recoveryReason: "replay_budget_exceeded",
      };
    }
    events.push(...page.events);
    if (page.complete) return { replay: { ...page, events } };
    const nextCursor = page.events.at(-1)?.sequence;
    if (nextCursor === undefined || nextCursor <= cursor) {
      return {
        replay: { ...page, complete: false, events },
        recoveryReason: "replay_unavailable",
      };
    }
    cursor = nextCursor;
  }
}
