import { EventId, TurnId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { retainThreadActivitiesAfterRevert } from "./helpers.store";

const TURN = TurnId.makeUnsafe("turn-1");
const activity = (id: string, kind: string) => ({
  id: EventId.makeUnsafe(id),
  tone: "info" as const,
  kind,
  summary: kind,
  payload: {},
  turnId: TURN,
  createdAt: "2026-10-16T10:00:00.000Z",
});

describe("web revert projection", () => {
  it("drops the prompt suggestion on revert, like the server projectors", () => {
    const kept = retainThreadActivitiesAfterRevert(
      [activity("tool", "tool.completed"), activity("suggestion", "prompt.suggestion")],
      new Set([TURN]),
    );
    expect(kept.map((entry) => entry.id)).toEqual(["tool"]);
  });
});
