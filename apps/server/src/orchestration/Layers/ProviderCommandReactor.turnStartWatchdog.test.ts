import { MessageId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationThread } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { describe, expect, it } from "vitest";

import { readModel } from "../deciderThreads.turn.queue.test.helpers.ts";
import {
  PENDING_TURN_START_TIMEOUT_MS,
  selectStalePendingTurnStarts,
} from "./ProviderCommandReactor.turnStartWatchdog.ts";

const gated = (messageId: string | null): OrchestrationThread =>
  readModel({
    pendingTurnStart:
      messageId === null
        ? null
        : { messageId: MessageId.makeUnsafe(messageId), requestedAt: "2000-01-01T00:00:00.000Z" },
  }).threads[0]!;

describe("turn start watchdog", () => {
  it("ages a gate from first sight on the server clock, not its requested time", () => {
    const firstSeenAt = new Map<string, number>();
    const select = (thread: OrchestrationThread, nowMs: number) =>
      selectStalePendingTurnStarts({ threads: [thread], firstSeenAt, nowMs });
    // A requestedAt decades old (client skew) is not stale on first sight.
    expect(select(gated("a"), 1_000)).toEqual([]);
    expect(select(gated("a"), 1_000 + PENDING_TURN_START_TIMEOUT_MS - 1)).toEqual([]);
    expect(select(gated("a"), 1_000 + PENDING_TURN_START_TIMEOUT_MS)).toHaveLength(1);
  });

  it("restarts the clock for a new start and forgets cleared gates", () => {
    const firstSeenAt = new Map<string, number>();
    selectStalePendingTurnStarts({ threads: [gated("a")], firstSeenAt, nowMs: 0 });
    const later = PENDING_TURN_START_TIMEOUT_MS;
    expect(
      selectStalePendingTurnStarts({ threads: [gated("b")], firstSeenAt, nowMs: later }),
    ).toEqual([]);
    expect(firstSeenAt.size).toBe(1);
    selectStalePendingTurnStarts({ threads: [gated(null)], firstSeenAt, nowMs: later });
    expect(firstSeenAt.size).toBe(0);
  });
});
