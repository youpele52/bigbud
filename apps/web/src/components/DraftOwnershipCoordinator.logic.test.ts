import { describe, expect, it } from "vitest";

import {
  DRAFT_OWNERSHIP_REPAIR_BY_RENDERER,
  getDraftOwnershipRepairConnection,
} from "./DraftOwnershipCoordinator.logic";

describe("DraftOwnershipCoordinator", () => {
  it("assigns one startup repair owner while both renderer surfaces reconcile selected state", () => {
    expect(DRAFT_OWNERSHIP_REPAIR_BY_RENDERER).toEqual({ main: true, compact: false });
  });

  it("retries an unavailable startup repair once after a new connection", () => {
    expect(
      getDraftOwnershipRepairConnection({
        bootstrapComplete: true,
        connection: { phase: "connected", connectedAt: "connection-1" },
        lastRepairConnection: null,
        repairOnStartup: true,
      }),
    ).toBe("connection-1");
    expect(
      getDraftOwnershipRepairConnection({
        bootstrapComplete: true,
        connection: { phase: "connected", connectedAt: "connection-1" },
        lastRepairConnection: "connection-1",
        repairOnStartup: true,
      }),
    ).toBeNull();
    expect(
      getDraftOwnershipRepairConnection({
        bootstrapComplete: true,
        connection: { phase: "connected", connectedAt: "connection-2" },
        lastRepairConnection: "connection-1",
        repairOnStartup: true,
      }),
    ).toBe("connection-2");
  });
});
