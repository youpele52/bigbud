import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { normalizeClaudeUsageLimits, readClaudeUsageLimits } from "./Provider.usageLimits";

const CHECKED_AT = "2026-09-06T12:00:00.000Z";

describe("Claude usage limits", () => {
  it("normalizes fixed and model-scoped windows in deterministic order", () => {
    expect(
      normalizeClaudeUsageLimits(
        {
          subscription_type: "max",
          rate_limits_available: true,
          rate_limits: {
            seven_day: { utilization: 70, resets_at: null },
            five_hour: { utilization: 20, resets_at: "2026-09-06T15:00:00Z" },
            model_scoped: [
              { display_name: "Sonnet", utilization: 60, resets_at: null },
              { display_name: "Opus", utilization: 40, resets_at: null },
            ],
            extra_usage: {
              is_enabled: true,
              monthly_limit: 100,
              used_credits: 25,
              utilization: 25,
              currency: "USD",
            },
          },
        },
        CHECKED_AT,
      ),
    ).toMatchObject({
      status: "available",
      checkedAt: CHECKED_AT,
      lastSuccessfulAt: CHECKED_AT,
      subscriptionType: "max",
      windows: [
        { id: "five_hour", utilization: 20 },
        { id: "seven_day", utilization: 70 },
        { id: "model_scoped:opus", utilization: 40 },
        { id: "model_scoped:sonnet", utilization: 60 },
      ],
      extraUsage: { enabled: true, monthlyLimit: 100, usedCredits: 25, utilization: 25 },
    });
  });

  it.each([
    { rate_limits_available: false, rate_limits: {} },
    { rate_limits_available: null, rate_limits: {} },
    { rate_limits_available: true, rate_limits: null },
  ])("maps inapplicable rate limits to unavailable", (response) => {
    expect(normalizeClaudeUsageLimits(response, CHECKED_AT)).toMatchObject({
      status: "unavailable",
      windows: [],
    });
  });

  it("fails closed with a generic message when the SDK rejects", async () => {
    const limits = await Effect.runPromise(
      readClaudeUsageLimits(() => Promise.reject(new Error("credential secret"))),
    );

    expect(limits).toMatchObject({
      status: "error",
      message: "Claude subscription limits could not be refreshed.",
      windows: [],
    });
    expect(JSON.stringify(limits)).not.toContain("credential secret");
  });

  it("fails closed when the SDK usage request does not settle", async () => {
    const limits = await Effect.runPromise(
      readClaudeUsageLimits(() => new Promise(() => undefined), 1),
    );

    expect(limits.status).toBe("error");
  });

  it("fails closed for malformed utilization", () => {
    expect(() =>
      normalizeClaudeUsageLimits(
        {
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: 101, resets_at: null } },
        },
        CHECKED_AT,
      ),
    ).toThrow();
  });
});
