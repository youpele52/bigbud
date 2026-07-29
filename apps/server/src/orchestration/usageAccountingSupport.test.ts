import { describe, expect, it } from "vitest";

import { supportsUsageAccounting, usageProviderCoverage } from "./usageAccountingSupport";

describe("CLIProxyAPI usage coverage", () => {
  it("marks translated usage unavailable until it is reliable", () => {
    expect(supportsUsageAccounting("cliProxy")).toBe(false);
    expect(usageProviderCoverage()).toContainEqual({
      provider: "cliProxy",
      status: "unavailable",
      reason: "This provider does not expose reliable token usage data.",
    });
  });
});
