import type { ServerProviderUsageLimits } from "@bigbud/contracts/server/usageLimits.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageSubscriptionLimits } from "./UsageSubscriptionLimits";

const available: ServerProviderUsageLimits = {
  status: "available",
  source: "claude-agent-sdk",
  checkedAt: "2026-10-08T12:00:00Z",
  windows: [{ id: "quota", label: "Monthly limit", kind: "monthly", utilization: 25 }],
};

const NativeDateTimeFormat = Intl.DateTimeFormat;
afterEach(() => vi.restoreAllMocks());

describe("grouped subscription limits", () => {
  it.each([
    ["claude-agent-sdk", "Claude"],
    ["codex-app-server", "Codex"],
    ["cursor-dashboard", "Cursor"],
    ["opencode-go-api", "OpenCode Go"],
  ] as const)("reuses the progress layout for %s", (source, label) => {
    const html = renderToStaticMarkup(
      <UsageSubscriptionLimits limits={[{ ...available, source }]} />,
    );
    expect(html).toContain(`aria-label="${label} subscription limits"`);
    expect(html).toContain("Remaining allowance");
    expect(html).not.toContain("Plan utilization");
    expect(html).toContain("Monthly limit");
    expect(html).toContain("75% remaining");
    if (source === "cursor-dashboard") expect(html).toContain("signed in to Cursor desktop");
  });
  it("keeps refresh available while unsupported and missing limits remain hidden", () => {
    for (const limits of [[], [undefined, { ...available, status: "unavailable" as const }]]) {
      const html = renderToStaticMarkup(<UsageSubscriptionLimits limits={limits} />);
      expect(html).toContain('aria-label="Refresh subscription limits"');
      expect(html).not.toContain('data-slot="card"');
      expect(html).toContain("Subscription limits unavailable for enabled providers.");
    }
  });

  it("shows display-only reset count and distinct expiry information directly after limits", () => {
    const html = renderToStaticMarkup(
      <UsageSubscriptionLimits
        limits={[
          {
            ...available,
            source: "codex-app-server",
            manualResets: {
              availableCount: 3,
              availableExpiries: ["2026-11-01T12:00:00Z", null],
              detailsComplete: false,
            },
          },
        ]}
      />,
    );
    expect(html).toContain("Limit resets");
    expect(html).toContain("Available (3)");
    expect(html).toContain("Available reset expiries");
    expect(html).toContain("No expiry");
    expect(html).toContain("Expiry unavailable for 1 reset");
    expect(html.indexOf("Limit resets")).toBeGreaterThan(html.indexOf("Monthly limit"));
    expect(html).not.toMatch(/Use reset|Redeem|redeem/);
  });

  it("does not invent manual resets for providers without grant data", () => {
    expect(renderToStaticMarkup(<UsageSubscriptionLimits limits={[available]} />)).not.toContain(
      "Limit resets",
    );
  });

  it("distinguishes zero available resets from missing expiry details", () => {
    const html = renderToStaticMarkup(
      <UsageSubscriptionLimits
        limits={[
          {
            ...available,
            source: "codex-app-server",
            manualResets: { availableCount: 0, availableExpiries: [], detailsComplete: true },
          },
        ]}
      />,
    );
    expect(html).toContain("Available (0)");
    expect(html).toContain("No available resets");
    expect(html).not.toContain("Expiry unavailable");
  });
  it("keeps retained quota visible with a stale-data warning", () => {
    const html = renderToStaticMarkup(
      <UsageSubscriptionLimits
        limits={[{ ...available, source: "cursor-dashboard", status: "stale" }]}
      />,
    );
    expect(html).toContain("Subscription limits may be out of date");
    expect(html).toContain("75% remaining");
  });

  it.each(["claude-agent-sdk", "codex-app-server", "cursor-dashboard", "opencode-go-api"] as const)(
    "uses consistent reset, expiry, and stale dates for %s",
    (source) => {
      vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
        return new NativeDateTimeFormat(locales, { ...options, timeZone: "Europe/Paris" });
      });
      const timestamp = "2026-10-21T17:00:00Z";
      const html = renderToStaticMarkup(
        <UsageSubscriptionLimits
          limits={[
            {
              ...available,
              source,
              status: "stale",
              lastSuccessfulAt: timestamp,
              windows: [{ ...available.windows[0]!, resetAt: timestamp }],
              manualResets: {
                availableCount: 1,
                availableExpiries: [timestamp],
                detailsComplete: true,
              },
            },
          ]}
        />,
      ).replace(/<[^>]*>/g, "");
      const expected = "October 21, 2026 at 7:00 PM CEST";
      expect(html).toContain(`Resets ${expected}`);
      expect(html).toContain(`Expires ${expected}`);
      expect(html).toContain(`Showing the last successful values from ${expected}.`);
    },
  );

  it("groups all providers in one card with provider subsections", () => {
    const html = renderToStaticMarkup(
      <UsageSubscriptionLimits
        limits={[
          { ...available, source: "codex-app-server", subscriptionType: "plus" },
          available,
          { ...available, source: "cursor-dashboard" },
          { ...available, source: "opencode-go-api" },
        ]}
      />,
    );
    expect(html.match(/data-slot="card"/g)).toHaveLength(1);
    expect(html.match(/<h2\b/g)).toHaveLength(1);
    expect(Array.from(html.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g), (match) => match[1])).toEqual([
      "Claude",
      "Codex",
      "Cursor",
      "OpenCode Go",
    ]);
    expect(html).toContain("plus subscription");
  });

  it("shows remaining percentages for metered extra usage, but does not invent unlimited allowances", () => {
    const html = renderToStaticMarkup(
      <UsageSubscriptionLimits
        limits={[
          {
            ...available,
            extraUsage: { enabled: true, monthlyLimit: 100, usedCredits: 25, currency: "USD" },
          },
          {
            ...available,
            source: "cursor-dashboard",
            extraUsage: { enabled: true, usedCredits: 30 },
          },
          { ...available, source: "opencode-go-api", extraUsage: { enabled: false } },
        ]}
      />,
    );
    expect(html).toContain("75 of 100 USD remaining");
    expect(html.match(/aria-label="Extra usage"/g)).toHaveLength(1);
    expect(html).toContain("Enabled");
    expect(html).toContain("Disabled");
    expect(html.replace(/<[^>]*>/g, "")).not.toContain("% used");
    expect(html).toContain('aria-description="25% used · 75% left"');
  });
});
