import { describe, expect, it } from "vitest";
import {
  extraUsageUtilization,
  formatAllowanceUsage,
  formatExtraUsageRemaining,
  formatRemainingAllowance,
  remainingAllowanceClassName,
  remainingAllowancePercent,
} from "./UsageSubscriptionLimits.logic";

describe("remaining subscription allowance", () => {
  it.each([
    [0, 100],
    [58, 42],
    [75, 25],
    [100, 0],
    [120, 0],
    [-10, 100],
    [99.5, 0.5],
  ])("converts %s%% used to %s%% remaining", (utilization, remaining) =>
    expect(remainingAllowancePercent(utilization)).toBe(remaining),
  );

  it("keeps fractional remaining allowance legible", () => {
    expect(formatRemainingAllowance(remainingAllowancePercent(99.5))).toBe("0.5% remaining");
    expect(formatRemainingAllowance(remainingAllowancePercent(58))).toBe("42% remaining");
  });

  it.each([
    [0, "0% used · 100% left"],
    [59, "59% used · 41% left"],
    [58.05, "58% used · 42% left"],
    [99.5, "99.5% used · 0.5% left"],
    [100, "100% used · 0% left"],
    [120, "100% used · 0% left"],
    [-10, "0% used · 100% left"],
  ])("formats complementary tooltip percentages for %s%% utilization", (utilization, details) => {
    expect(formatAllowanceUsage(utilization)).toBe(details);
  });

  it.each([
    [100, "available", "bg-info"],
    [20, "available", "bg-warning"],
    [5, "available", "bg-destructive"],
    [100, "stale", "bg-warning"],
    [0, "stale", "bg-destructive"],
  ] as const)("keeps severity correct for %s%% remaining in %s state", (remaining, status, color) =>
    expect(remainingAllowanceClassName(remaining, status)).toBe(color),
  );

  it("computes extra allowance from credits when no percentage is reported", () => {
    const extra = { enabled: true, usedCredits: 25, monthlyLimit: 100, currency: "USD" };
    expect(extraUsageUtilization(extra)).toBe(25);
    expect(formatExtraUsageRemaining(extra)).toBe("75 of 100 USD remaining");
    expect(extraUsageUtilization({ ...extra, utilization: 50 })).toBe(50);
    expect(extraUsageUtilization({ ...extra, utilization: 0 })).toBe(0);
  });

  it("clamps exhausted extra credit allowances to zero remaining", () => {
    const extra = { enabled: true, usedCredits: 120, monthlyLimit: 100 };
    expect(remainingAllowancePercent(extraUsageUtilization(extra)!)).toBe(0);
    expect(formatExtraUsageRemaining(extra)).toBe("0 of 100 remaining");
  });

  it("uses direct extra-usage percentages when a spending cap is omitted", () => {
    expect(
      remainingAllowancePercent(extraUsageUtilization({ enabled: true, utilization: 40 })!),
    ).toBe(60);
  });

  it("does not invent percentages for disabled, missing, or unlimited extra allowances", () => {
    for (const extra of [
      { enabled: false, utilization: 25 },
      { enabled: true },
      { enabled: true, usedCredits: 25 },
      { enabled: true, monthlyLimit: 100 },
      { enabled: true, usedCredits: 25, monthlyLimit: 0 },
    ])
      expect(extraUsageUtilization(extra)).toBeUndefined();
    expect(formatExtraUsageRemaining({ enabled: false })).toBe("Disabled");
    expect(formatExtraUsageRemaining({ enabled: true })).toBe("Enabled");
  });
});
