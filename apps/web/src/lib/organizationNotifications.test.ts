import { describe, expect, it } from "vitest";
import { makeEvent } from "../stores/main/main.store.test.helpers";
import { ThreadId } from "@bigbud/contracts";
import {
  collectOrganizationNotifications,
  groupOrganizationNotifications,
  manualOrganizationMoveDescription,
  recentOrganizationNotifications,
} from "./organizationNotifications";

const serverNow = Date.parse("2026-11-05T12:00:10.000Z");
const move = (sequence: number, state: "later" | "done" = "later", at = serverNow) => ({
  ...makeEvent("thread.organization-updated", {
    threadId: ThreadId.makeUnsafe(`thread-${sequence}`),
    reason: "idle",
    source: "automatic",
    organization: { state, revision: 2, changedAt: null, snooze: null },
    automaticMove: { operationId: `move-${sequence}`, from: "present", reason: "target" },
  }),
  sequence,
  occurredAt: new Date(at).toISOString(),
});

describe("confirmed organisation notifications", () => {
  it("admits only automatic moves after the live sequence frontier", () => {
    const events = [move(9), move(10), move(11)];
    expect(collectOrganizationNotifications(events, null)).toEqual([]);
    expect(collectOrganizationNotifications(events, 10)).toEqual([events[2]]);
  });
  it("caps age on the server clock only, whatever the client clock says", () => {
    const fresh = move(1, "later", serverNow - 1000);
    const old = move(2, "later", serverNow - 20000);
    expect(recentOrganizationNotifications([fresh, old], serverNow)).toEqual([fresh]);
  });
  it("never toasts deliberate moves, another client's moves or Undo restorations", () => {
    const automatic = move(5);
    const { automaticMove: _, ...payload } = automatic.payload;
    const manual = {
      ...automatic,
      sequence: 6,
      payload: { ...payload, reason: "move" as const, source: "deliberate" as const },
    };
    expect(collectOrganizationNotifications([automatic, manual], 0)).toEqual([automatic]);
  });
  it("groups by destination, most recent first", () => {
    const a = move(1);
    const b = move(2, "done");
    const c = move(3);
    expect(groupOrganizationNotifications([a, b, c])).toEqual([[c, a], [b]]);
  });
  it("explains the fixed manual return accurately", () => {
    expect(manualOrganizationMoveDescription("later")).toContain("10 minutes");
    expect(manualOrganizationMoveDescription("done")).toContain("Needs you sooner");
    expect(manualOrganizationMoveDescription("needs-you")).toContain("and no request remains");
    expect(manualOrganizationMoveDescription("present")).toContain("New approvals");
  });
});
