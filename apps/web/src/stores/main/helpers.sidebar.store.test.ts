import { ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { mergeDeletingSidebarMembership } from "./helpers.sidebar.store";

describe("mergeDeletingSidebarMembership", () => {
  it("retains local deleting ids omitted from the catalog", () => {
    const deleting = ThreadId.makeUnsafe("deleting");
    const visible = ThreadId.makeUnsafe("visible");
    expect(
      mergeDeletingSidebarMembership({
        catalogThreadIds: [visible],
        localThreadIds: [deleting, visible],
        localThreads: [
          { id: deleting, deletingAt: "2026-02-27T00:00:00.000Z" },
          { id: visible, deletingAt: null },
        ],
        catalogAvailableIds: new Set([visible]),
        limit: 6,
      }),
    ).toEqual([deleting, visible]);
  });
});
