import { describe, expect, it } from "vitest";
import { sortThreadsForSidebar } from "./Sidebar.sort.logic";
import { threadRecencyAt } from "../../logic/thread/threadRecency.logic";

const thread = (
  id: string,
  latestUserMessageAt: string | null,
  latestTerminalActivityAt: string | null,
) => ({
  id: id as never,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  latestUserMessageAt,
  latestTerminalActivityAt,
});

describe("terminal recency in the sidebar order", () => {
  const chatOnly = thread("chat", "2026-01-05T00:00:00.000Z", null);
  const terminalOnly = thread("terminal", null, "2026-01-07T00:00:00.000Z");
  const mixed = thread("mixed", "2026-01-03T00:00:00.000Z", "2026-01-06T00:00:00.000Z");
  const untouched = thread("untouched", null, null);

  it("orders by the later of the latest message and terminal activity", () => {
    expect(
      sortThreadsForSidebar([chatOnly, untouched, mixed, terminalOnly], "updated_at").map(
        (entry) => entry.id,
      ),
    ).toEqual(["terminal", "mixed", "chat", "untouched"]);
  });

  it("keeps creation order untouched by terminal activity", () => {
    expect(
      sortThreadsForSidebar([chatOnly, terminalOnly], "created_at").map((entry) => entry.id),
    ).toEqual(["terminal", "chat"]);
  });

  it("labels rows with the same recency instant", () => {
    expect(threadRecencyAt(chatOnly)).toBe("2026-01-05T00:00:00.000Z");
    expect(threadRecencyAt(terminalOnly)).toBe("2026-01-07T00:00:00.000Z");
    expect(threadRecencyAt(mixed)).toBe("2026-01-06T00:00:00.000Z");
    expect(threadRecencyAt(untouched)).toBe("2026-01-01T00:00:00.000Z");
  });
});
