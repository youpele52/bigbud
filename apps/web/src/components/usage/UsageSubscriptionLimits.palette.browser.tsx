import "../../index.css";
import type { ServerProviderUsageLimits } from "@bigbud/contracts/server/usageLimits.ts";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { Gauge } from "../ui/gauge";
import { UsageSubscriptionLimits } from "./UsageSubscriptionLimits";
import { remainingAllowancePercent } from "./UsageSubscriptionLimits.logic";

afterEach(() => document.documentElement.classList.remove("dark"));

it.each(
  [false, true].flatMap((dark) =>
    [0, 49.999, 50, 79.999, 80, 125].map((utilization) => ({ dark, utilization })),
  ),
)(
  "matches gauge bands for fresh quotas and stale extra usage without inverting width (dark: $dark, $utilization%)",
  async ({ dark, utilization }) => {
    document.documentElement.classList.toggle("dark", dark);
    const base: ServerProviderUsageLimits = {
      source: "claude-agent-sdk",
      status: "available",
      checkedAt: "2026-09-06T12:00:00.000Z",
      windows: [{ id: "quota", kind: "monthly", label: "Monthly limit", utilization }],
    };
    const screen = await render(
      <div style={{ width: 800 }}>
        <Gauge value={utilization} label="Reference usage" />
        <UsageSubscriptionLimits
          limits={[
            base,
            {
              ...base,
              source: "codex-app-server",
              status: "stale",
              windows: [],
              extraUsage: { enabled: true, utilization },
            },
          ]}
        />
      </div>,
    );
    try {
      const gauge = screen.getByRole("meter", { name: "Reference usage" }).element();
      const gaugeValue = gauge.querySelector('[data-slot="gauge-value"]')!;
      const remaining = remainingAllowancePercent(utilization);
      for (const label of ["Monthly limit", "Extra usage"]) {
        const bar = screen.getByRole("progressbar", { name: label, exact: true });
        await expect.element(bar).toHaveAttribute("aria-valuenow", String(remaining));
        await expect
          .element(bar)
          .toHaveAttribute("aria-valuetext", `${Math.round(remaining * 10) / 10}% remaining`);
        const fill = bar.element().querySelector('[data-slot="progress-indicator"]')!;
        const track = bar.element().querySelector('[data-slot="progress-track"]')!;
        expect(getComputedStyle(fill).backgroundColor).toBe(getComputedStyle(gaugeValue).color);
        await expect
          .poll(() => fill.getBoundingClientRect().width / track.getBoundingClientRect().width)
          .toBeCloseTo(remaining / 100, 2);
      }
      await expect
        .element(screen.getByText("Subscription limits may be out of date"))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  },
);
