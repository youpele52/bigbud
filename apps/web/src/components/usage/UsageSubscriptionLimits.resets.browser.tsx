import "../../index.css";
import { page } from "vitest/browser";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { UsageSubscriptionLimits } from "./UsageSubscriptionLimits";

let mounted: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

it.each([
  [false, 375, 280],
  [true, 375, 280],
  [false, 1280, 800],
  [true, 1280, 800],
] as const)(
  "shows subordinate reset labels and a half-width divider in compact=%s at viewport=%s",
  async (compact, viewportWidth, width) => {
    await page.viewport(viewportWidth, 900);
    const expiry = "2026-10-29T19:06:00Z";
    mounted = await render(
      <div style={{ width }}>
        <UsageSubscriptionLimits
          compact={compact}
          limits={[
            {
              source: "codex-app-server",
              status: "available",
              checkedAt: expiry,
              windows: [
                {
                  id: "primary",
                  kind: "five-hour",
                  label: "5-hour limit",
                  utilization: 10,
                  resetAt: expiry,
                },
              ],
              manualResets: {
                availableCount: 4,
                availableExpiries: [expiry, expiry, null],
                detailsComplete: false,
              },
            },
            { source: "claude-agent-sdk", status: "available", checkedAt: expiry, windows: [] },
          ]}
        />
      </div>,
    );
    const section = mounted.getByRole("region", { name: "Limit resets", exact: true });
    const available = section.getByRole("button", { name: "Available (4)", exact: true });
    await expect.element(available).toHaveAttribute("aria-pressed", "true");
    await expect.element(available).toBeDisabled();
    const codex = mounted.getByRole("region", { name: "Codex subscription limits", exact: true });
    const providerHeading = codex.getByRole("heading", { name: "Codex", exact: true });
    const resetHeading = section.getByRole("heading", { name: "Limit resets", exact: true });
    const providerStyle = getComputedStyle(providerHeading.element());
    for (const label of [resetHeading, available]) {
      const style = getComputedStyle(label.element());
      expect(style.fontSize).toBe("12px");
      expect(style.fontWeight).toBe("400");
      expect(parseFloat(style.fontSize)).toBeLessThan(parseFloat(providerStyle.fontSize));
      expect(Number(style.fontWeight)).toBeLessThan(Number(providerStyle.fontWeight));
    }
    expect(available.element().hasAttribute("data-pressed")).toBe(true);
    expect(section.getByRole("button").all()).toHaveLength(1);
    expect(section.element().textContent).not.toMatch(/History|Banked resets|1 ·|Redeem|Use reset/);
    const list = section.getByRole("list", { name: "Available reset expiries" });
    expect(list.getByRole("listitem").all()).toHaveLength(3);
    const times = list.element().querySelectorAll("time");
    expect(times).toHaveLength(2);
    const device = new Intl.DateTimeFormat("en-GB", {
      timeZoneName: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    const parts = new Map(
      device.formatToParts(new Date(expiry)).map((part) => [part.type, part.value]),
    );
    for (const time of times) {
      expect(time.dateTime).toBe(expiry);
      expect(time.textContent).toMatch(
        /^Expires [A-Z][a-z]+ \d{1,2}, \d{4} at \d{1,2}:\d{2} [AP]M .+$/,
      );
      expect(time.textContent).toContain(
        ` at ${parts.get("hour")}:${parts.get("minute")} ${parts.get("dayPeriod")!.toUpperCase()} `,
      );
      expect(time.textContent).toContain(
        `Expires ${parts.get("month")} ${parts.get("day")}, ${parts.get("year")}`,
      );
      expect(time.textContent).not.toMatch(/[AP]M (?:GMT|UTC)[+\-\u2212]/);
      const localName = parts.get("timeZoneName");
      if (localName && !/^(?:GMT|UTC)[+\-\u2212]/.test(localName))
        expect(time.textContent).toContain(` ${localName}`);
    }
    expect(times[0]?.textContent).toBe(times[1]?.textContent);
    await expect.element(section.getByText("No expiry", { exact: true })).toBeVisible();
    await expect.element(section.getByText("Expiry unavailable for 1 reset")).toBeVisible();
    expect(getComputedStyle(section.element()).borderTopWidth).toBe("0px");
    expect(section.element().querySelectorAll('[data-slot="separator"], hr')).toHaveLength(1);
    const divider = section.getByRole("separator");
    const dividerRect = divider.element().getBoundingClientRect();
    const sectionRect = section.element().getBoundingClientRect();
    expect(dividerRect.width).toBeCloseTo(sectionRect.width / 2, 1);
    expect(dividerRect.left).toBe(sectionRect.left);
    expect(dividerRect.height).toBe(1);
    expect(resetHeading.element().getBoundingClientRect().top).toBeGreaterThan(dividerRect.bottom);
    expect(section.element().scrollWidth).toBeLessThanOrEqual(section.element().clientWidth);
    const reset = codex.getByText(times[0]!.textContent!.replace(/^Expires /, "Resets "), {
      exact: true,
    });
    await expect.element(reset).toBeVisible();
    expect(dividerRect.top).toBeGreaterThan(reset.element().getBoundingClientRect().bottom);
    expect(codex.element().scrollWidth).toBeLessThanOrEqual(codex.element().clientWidth);
    const claude = mounted.getByRole("region", { name: "Claude subscription limits", exact: true });
    expect(getComputedStyle(divider.element()).backgroundColor).toBe(
      getComputedStyle(claude.element()).borderBottomColor,
    );
    expect(claude.element().getBoundingClientRect().width).toBe(sectionRect.width);
    expect(
      parseFloat(getComputedStyle(codex.element()).borderTopWidth) +
        parseFloat(getComputedStyle(claude.element()).borderBottomWidth),
    ).toBeGreaterThan(0);
  },
);
