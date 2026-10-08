import type { ServerProviderUsageLimits } from "@bigbud/contracts/server/usageLimits.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UsageSubscriptionLimits } from "./UsageSubscriptionLimits";

const available: ServerProviderUsageLimits = {
  status: "available",
  source: "claude-agent-sdk",
  checkedAt: "2026-10-08T12:00:00Z",
  windows: [{ id: "quota", label: "Monthly limit", kind: "monthly", utilization: 25 }],
};

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
  it("hides unsupported and missing limits", () => {
    expect(renderToStaticMarkup(<UsageSubscriptionLimits limits={[]} />)).toBe("");
    expect(
      renderToStaticMarkup(
        <UsageSubscriptionLimits limits={[undefined, { ...available, status: "unavailable" }]} />,
      ),
    ).toBe("");
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
