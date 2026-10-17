import { describe, expect, it } from "vitest";
import { normalizeCodexUsageLimits } from "./Layers/Codex/Provider.usageLimits.ts";
import { normalizeCursorUsageLimits } from "./Layers/Cursor/Provider.usageLimits.normalize.ts";
import { normalizeOpencodeGoUsageLimits } from "./Layers/Opencode/Provider.usageLimits.normalize.ts";

const checkedAt = "2026-10-08T12:00:00.000Z";

describe("provider subscription usage normalization", () => {
  it("uses Codex's reported durations and multiple buckets without duplicating the legacy view", () => {
    const result = normalizeCodexUsageLimits(
      {
        rateLimits: { primary: { usedPercent: 99 } },
        rateLimitsByLimitId: {
          codex: {
            planType: "plus",
            primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1791460800 },
            secondary: { usedPercent: 30, windowDurationMins: 10080 },
          },
          spark: { limitName: "Spark", primary: { usedPercent: 40, windowDurationMins: 60 } },
        },
      },
      checkedAt,
    );
    expect(result.subscriptionType).toBe("plus");
    expect(result.windows.map((window) => [window.label, window.utilization])).toEqual([
      ["5-hour limit", 20],
      ["7-day limit", 30],
      ["Spark 1-hour limit", 40],
    ]);
    expect(result.windows[0]?.resetAt).toBe(new Date(1791460800 * 1000).toISOString());
    expect(result.windows[1]).not.toHaveProperty("resetAt");
  });

  it("supports Codex's older single-bucket response and hides empty limits", () => {
    expect(
      normalizeCodexUsageLimits({ rateLimits: { primary: { usedPercent: 0 } } }, checkedAt)
        .windows[0],
    ).toMatchObject({ label: "Primary limit", utilization: 0 });
    expect(normalizeCodexUsageLimits({ rateLimits: { primary: null } }, checkedAt).status).toBe(
      "unavailable",
    );
  });

  it("maps Cursor monthly usage, model breakdowns, and cents-based extra usage", () => {
    const result = normalizeCursorUsageLimits(
      {
        membershipType: "pro",
        billingCycleEnd: "2026-11-01T00:00:00Z",
        individualUsage: {
          plan: { enabled: true, totalPercentUsed: 40, autoPercentUsed: 10, apiPercentUsed: 30 },
          onDemand: { enabled: true, used: 250, limit: 1000 },
        },
      },
      checkedAt,
    );
    expect(result.windows.map((window) => window.utilization)).toEqual([40, 10, 30]);
    expect(result.windows.every((window) => window.resetAt === "2026-11-01T00:00:00.000Z")).toBe(
      true,
    );
    expect(result.extraUsage).toEqual({
      enabled: true,
      usedCredits: 2.5,
      monthlyLimit: 10,
      currency: "USD",
    });
  });

  it("prefers Cursor personal caps over the shared team pool and ordinary plan", () => {
    const result = normalizeCursorUsageLimits(
      {
        individualUsage: {
          overall: { enabled: true, used: 4000, limit: 10000 },
          plan: { totalPercentUsed: 99, autoPercentUsed: 10 },
        },
        teamUsage: { pooled: { used: 9000, limit: 10000 } },
      },
      checkedAt,
    );
    expect(result.windows).toEqual([
      { id: "monthly", kind: "monthly", label: "Personal monthly limit", utilization: 40 },
    ]);
  });

  it("does not fabricate Cursor allowances from missing or unlimited data", () => {
    for (const value of [
      {},
      { isUnlimited: true },
      { individualUsage: { plan: { limit: 100 } } },
    ]) {
      expect(normalizeCursorUsageLimits(value, checkedAt).status).toBe("unavailable");
    }
  });

  it("keeps Go fractional percentages in percentage units and unknown resets absent", () => {
    const result = normalizeOpencodeGoUsageLimits(
      {
        usage: {
          rolling: { percent: 0.5, resetInSec: 3600 },
          weekly: { percent: 1, resetsAt: "2026-10-15T12:00:00Z" },
          monthly: { percent: 65 },
        },
      },
      checkedAt,
    );
    expect(result.windows.map((window) => window.utilization)).toEqual([0.5, 1, 65]);
    expect(result.windows[0]?.resetAt).toBe("2026-10-08T13:00:00.000Z");
    expect(result.windows[1]?.resetAt).toBe("2026-10-15T12:00:00.000Z");
    expect(result.windows[2]).not.toHaveProperty("resetAt");
  });

  it("accepts the Go API's usagePercent and used/limit encodings without rescaling", () => {
    const result = normalizeOpencodeGoUsageLimits(
      {
        usage: {
          rolling: { usagePercent: 0.5 },
          weekly: { used: 1, limit: 100 },
          monthly: { used: 1, limit: 200 },
        },
      },
      checkedAt,
    );
    expect(result.windows.map((window) => window.utilization)).toEqual([0.5, 1, 0.5]);
  });

  it.each([NaN, Infinity, -1, "42"])(
    "rejects invalid percentages instead of publishing zero: %s",
    (percent) => {
      expect(() =>
        normalizeCodexUsageLimits({ rateLimits: { primary: { usedPercent: percent } } }, checkedAt),
      ).toThrow();
      expect(() =>
        normalizeCursorUsageLimits(
          { individualUsage: { plan: { totalPercentUsed: percent } } },
          checkedAt,
        ),
      ).toThrow();
      expect(() =>
        normalizeOpencodeGoUsageLimits({ usage: { rolling: { percent } } }, checkedAt),
      ).toThrow();
    },
  );

  it("saturates over-quota progress bars without rejecting authoritative usage", () => {
    expect(
      normalizeOpencodeGoUsageLimits({ usage: { rolling: { percent: 110 } } }, checkedAt).windows[0]
        ?.utilization,
    ).toBe(100);
  });
});
