import { describe, expect, it } from "vitest";
import { normalizeCodexUsageLimits } from "./Provider.usageLimits.ts";

const checkedAt = "2026-10-21T12:00:00.000Z";
const window = { primary: { usedPercent: 25, resetsAt: 1792587600 } };
const grant = {
  id: "opaque-account-credit",
  resetType: "codexRateLimits",
  status: "available",
  expiresAt: 1793534400,
};
const normalize = (rateLimitResetCredits?: unknown) =>
  normalizeCodexUsageLimits({ rateLimits: window, rateLimitResetCredits }, checkedAt);

describe("Codex banked resets", () => {
  it("preserves legacy quotas without claiming zero resets", () => {
    expect(normalize().manualResets).toBeUndefined();
    expect(normalize(null).manualResets).toBeUndefined();
    expect(normalize().windows).toHaveLength(1);
  });

  it("keeps zero, count-only, partial details and explicit no-expiry distinct", () => {
    expect(normalize({ availableCount: 0, credits: [] }).manualResets).toEqual({
      availableCount: 0,
      availableExpiries: [],
      detailsComplete: true,
    });
    expect(normalize({ availableCount: 2, credits: null }).manualResets).toEqual({
      availableCount: 2,
      availableExpiries: [],
      detailsComplete: false,
    });
    expect(
      normalize({
        availableCount: 3,
        credits: [grant, { ...grant, id: "second", expiresAt: null }],
      }).manualResets,
    ).toEqual({
      availableCount: 3,
      availableExpiries: ["2026-11-01T12:00:00.000Z", null],
      detailsComplete: false,
    });
    expect(
      normalize({ availableCount: 1, credits: [{ ...grant, expiresAt: null }] }).manualResets
        ?.detailsComplete,
    ).toBe(true);
  });

  it("only exposes available supported grants, never IDs, redeemed grants or automatic reset timestamps", () => {
    const result = normalize({
      availableCount: 1,
      credits: [
        grant,
        { ...grant, id: "used", status: "redeemed" },
        { ...grant, id: "other", resetType: "unknown" },
      ],
    });
    expect(result.manualResets).toEqual({
      availableCount: 1,
      availableExpiries: ["2026-11-01T12:00:00.000Z"],
      detailsComplete: true,
    });
    expect(JSON.stringify(result.manualResets)).not.toContain("opaque-account-credit");
    expect(result.manualResets?.availableExpiries).not.toContain(result.windows[0]?.resetAt);
  });

  it.each([
    "bad",
    { availableCount: -1 },
    { availableCount: 1.5 },
    { availableCount: Infinity },
    { availableCount: "2" },
  ])("malformed supplementary data never discards valid windows: %j", (credits) => {
    expect(normalize(credits).windows[0]?.utilization).toBe(25);
    expect(normalize(credits).manualResets).toBeUndefined();
  });

  it.each([undefined, "bad", Infinity, 1e300, -1])(
    "bad expiry remains unknown rather than no-expiry: %s",
    (expiresAt) => {
      const result = normalize({ availableCount: 1, credits: [{ ...grant, expiresAt }] });
      expect(result.manualResets).toEqual({
        availableCount: 1,
        availableExpiries: [],
        detailsComplete: false,
      });
      expect(result.windows).toHaveLength(1);
    },
  );

  it("does not duplicate grants or overstate contradictory details", () => {
    expect(normalize({ availableCount: 2, credits: [grant, grant] }).manualResets).toMatchObject({
      availableExpiries: ["2026-11-01T12:00:00.000Z"],
      detailsComplete: false,
    });
    expect(normalize({ availableCount: 0, credits: [grant] }).manualResets).toEqual({
      availableCount: 0,
      availableExpiries: [],
      detailsComplete: false,
    });
  });
});
