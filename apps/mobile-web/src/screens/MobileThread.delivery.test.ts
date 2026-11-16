import type { ClientOrchestrationCommand } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import type { MobileCommandDeliveryState } from "../lib/mobileCommandDelivery.logic";
import { selectCommandToRecheck } from "./MobileThread.delivery";

function stateOf(
  status: MobileCommandDeliveryState["status"],
  extra: Partial<MobileCommandDeliveryState> = {},
): MobileCommandDeliveryState {
  return {
    status,
    operation: {
      command: { commandId: "command-1" } as unknown as ClientOrchestrationCommand,
      submittedRevision: 1,
      submittedAt: "2026-01-01T00:00:00.000Z",
      deadlineAt: 0,
    },
    ...extra,
  };
}

describe("selectCommandToRecheck", () => {
  it("checks an uncertain send once the stream is caught up", () => {
    expect(
      selectCommandToRecheck({
        freshness: "current",
        state: stateOf("uncertain"),
        checked: new Set(),
      }),
    ).toBe("command-1");
  });

  it("waits while recovery is not current", () => {
    for (const freshness of ["refreshing", "stale", "legacy", "unavailable"] as const) {
      expect(
        selectCommandToRecheck({ freshness, state: stateOf("uncertain"), checked: new Set() }),
      ).toBeNull();
    }
  });

  it("checks at most once per caught-up period", () => {
    expect(
      selectCommandToRecheck({
        freshness: "current",
        state: stateOf("uncertain"),
        checked: new Set(["command-1"]),
      }),
    ).toBeNull();
  });

  it("leaves settled sends and known-unknown outcomes alone", () => {
    for (const state of [
      stateOf("accepted"),
      stateOf("pending"),
      stateOf("reconciling"),
      stateOf("uncertain", { outcomeUnknown: true }),
      { status: "idle", operation: null } satisfies MobileCommandDeliveryState,
    ]) {
      expect(selectCommandToRecheck({ freshness: "current", state, checked: new Set() })).toBe(
        null,
      );
    }
  });
});
