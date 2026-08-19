import { ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { shouldRefreshSidebarCatalog } from "./-__root.sidebar-catalog";

function makeEvent(
  type: "thread.deletion-requested" | "thread.deletion-failed" | "thread.deleted",
) {
  const threadId = ThreadId.makeUnsafe("thread-1");
  const occurredAt = "2026-02-27T00:00:00.000Z";
  return {
    sequence: 1,
    eventId: "event-1",
    aggregateKind: "thread" as const,
    aggregateId: threadId,
    occurredAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload:
      type === "thread.deleted"
        ? { threadId, deletedAt: occurredAt }
        : type === "thread.deletion-requested"
          ? { threadId, deletingAt: occurredAt }
          : { threadId, updatedAt: occurredAt },
  };
}

describe("shouldRefreshSidebarCatalog", () => {
  it("does not refresh on deletion-requested so in-flight membership can survive", () => {
    expect(shouldRefreshSidebarCatalog(makeEvent("thread.deletion-requested") as never)).toBe(
      false,
    );
  });

  it("refreshes after deletion settles", () => {
    expect(shouldRefreshSidebarCatalog(makeEvent("thread.deletion-failed") as never)).toBe(true);
    expect(shouldRefreshSidebarCatalog(makeEvent("thread.deleted") as never)).toBe(true);
  });
});
