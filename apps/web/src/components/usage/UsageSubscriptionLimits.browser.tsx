import "../../index.css";

import type { ServerProviderUsageLimits } from "@bigbud/contracts/server/usageLimits.ts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { UsageSubscriptionLimits } from "./UsageSubscriptionLimits";

const checkedAt = "2026-09-06T12:00:00.000Z";
let mounted: Awaited<ReturnType<typeof render>> | undefined;

async function renderLimits(...limits: ServerProviderUsageLimits[]) {
  const host = document.createElement("div");
  document.body.append(host);
  mounted = await render(<UsageSubscriptionLimits limits={limits} />, { container: host });
  return mounted;
}

function status(status: ServerProviderUsageLimits["status"]): ServerProviderUsageLimits {
  return {
    status,
    source: "claude-agent-sdk",
    checkedAt,
    windows: [],
    ...(status === "error"
      ? { message: "Claude subscription limits could not be refreshed." }
      : {}),
  };
}

describe("UsageSubscriptionLimits", () => {
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
    document.body.innerHTML = "";
  });

  it("renders available windows, subscription type, and extra usage", async () => {
    await renderLimits({
      ...status("available"),
      lastSuccessfulAt: checkedAt,
      subscriptionType: "max",
      windows: [{ id: "five_hour", kind: "five-hour", label: "5-hour limit", utilization: 42 }],
      extraUsage: { enabled: true, monthlyLimit: 100, usedCredits: 25, currency: "USD" },
    });

    await expect.element(page.getByText("max subscription")).toBeInTheDocument();
    await expect.element(page.getByText("5-hour limit")).toBeInTheDocument();
    await expect.element(page.getByText("58% remaining")).toBeInTheDocument();
    await expect.element(page.getByText("75 of 100 USD remaining")).toBeInTheDocument();
    const progress = page.getByRole("progressbar", { name: "5-hour limit" });
    await expect.element(progress).toHaveAttribute("aria-valuenow", "58");
    await expect.element(progress).toHaveAttribute("aria-valuetext", "58% remaining");
    await expect
      .element(page.getByRole("progressbar", { name: "Extra usage" }))
      .toHaveAttribute("aria-valuenow", "75");
  });

  it.each([
    ["pending", "Checking Claude subscription limits..."],
    ["error", "Couldn't load Claude subscription limits"],
  ] as const)("renders the %s state", async (state, text) => {
    await renderLimits(status(state));
    await expect.element(page.getByText(text)).toBeInTheDocument();
  });

  it("renders retained bars and the last-success timestamp while stale", async () => {
    await renderLimits({
      ...status("stale"),
      lastSuccessfulAt: checkedAt,
      windows: [{ id: "seven_day", kind: "seven-day", label: "7-day limit", utilization: 75 }],
    });

    await expect
      .element(page.getByText("Subscription limits may be out of date"))
      .toBeInTheDocument();
    await expect.element(page.getByText("7-day limit")).toBeInTheDocument();
    await expect.element(page.getByText("25% remaining")).toBeInTheDocument();
  });

  it("hides unsupported subscription limits", async () => {
    await renderLimits(status("unavailable"));
    expect(document.querySelector("section")).toBeNull();
  });

  it.each([
    ["codex-app-server", "Codex"],
    ["cursor-dashboard", "Cursor"],
    ["opencode-go-api", "OpenCode Go"],
  ] as const)("renders %s with the provider's own title", async (source, label) => {
    await renderLimits({
      ...status("available"),
      source,
      windows: [{ id: "quota", kind: "monthly", label: "Monthly limit", utilization: 25 }],
    });
    await expect
      .element(page.getByRole("heading", { name: label, exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByText("75% remaining")).toBeInTheDocument();
  });

  it("groups all limits into one card and preserves reset information", async () => {
    await renderLimits(
      ...(
        ["codex-app-server", "claude-agent-sdk", "cursor-dashboard", "opencode-go-api"] as const
      ).map((source) => ({
        status: "available" as const,
        checkedAt,
        source,
        windows: [
          {
            id: "quota",
            kind: "monthly" as const,
            label: "Monthly limit",
            utilization: 58,
            resetAt: "2026-10-14T10:32:00Z",
          },
        ],
      })),
    );
    expect(document.querySelectorAll('[data-slot="card"]')).toHaveLength(1);
    await expect
      .element(page.getByRole("heading", { name: "Subscription limits", exact: true }))
      .toBeInTheDocument();
    expect(Array.from(document.querySelectorAll("h3"), (heading) => heading.textContent)).toEqual([
      "Claude",
      "Codex",
      "Cursor",
      "OpenCode Go",
    ]);
    expect(document.querySelectorAll('[aria-valuetext="42% remaining"]')).toHaveLength(4);
    expect(document.body.textContent).toContain("Resets");
    expect(document.body.textContent).not.toContain("Plan utilization");
    const heading = page
      .getByRole("heading", { level: 2, name: "Subscription limits", exact: true })
      .element();
    expect(heading.closest('[data-slot="card"]')).toBeNull();
    expect(getComputedStyle(heading).fontSize).toBe("18px");
    expect(getComputedStyle(heading).fontWeight).toBe("600");
  });

  it("shows used and left percentages when hovering anywhere on a quota row", async () => {
    await renderLimits({
      ...status("available"),
      windows: [{ id: "quota", kind: "monthly", label: "Monthly limit", utilization: 59 }],
    });
    await expect.element(page.getByText("41% remaining")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull();
    await page.getByRole("progressbar", { name: "Monthly limit" }).hover();
    await expect.element(page.getByText("59% used · 41% left")).toBeVisible();
  });

  it("exposes quota details on keyboard focus and dismisses them with Escape", async () => {
    await renderLimits({
      ...status("available"),
      windows: [{ id: "quota", kind: "five-hour", label: "5-hour limit", utilization: 99.5 }],
    });
    const progress = page.getByRole("progressbar", { name: "5-hour limit" });
    await expect.element(progress).toHaveAttribute("tabindex", "0");
    await userEvent.tab();
    await expect.element(progress).toHaveFocus();
    await expect.element(page.getByText("99.5% used · 0.5% left")).toBeVisible();
    await expect.element(progress).toHaveAttribute("aria-description", "99.5% used · 0.5% left");
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByText("99.5% used · 0.5% left")).not.toBeInTheDocument();
  });

  it("provides details for metered extra usage without inventing disabled or unmetered percentages", async () => {
    await renderLimits(
      { ...status("available"), extraUsage: { enabled: true, monthlyLimit: 100, usedCredits: 25 } },
      { ...status("available"), source: "codex-app-server", extraUsage: { enabled: false } },
      { ...status("available"), source: "cursor-dashboard", extraUsage: { enabled: true } },
    );
    expect(document.querySelectorAll('[data-slot="tooltip-trigger"]')).toHaveLength(1);
    await page.getByRole("progressbar", { name: "Extra usage" }).hover();
    await expect.element(page.getByText("25% used · 75% left")).toBeVisible();
    await expect.element(page.getByText("Disabled", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Enabled", { exact: true })).toBeInTheDocument();
  });

  it.each([
    [0, 100, "bg-info"],
    [90, 10, "bg-warning"],
    [100, 0, "bg-destructive"],
  ] as const)(
    "shows %s%% used as %s%% remaining with the correct severity",
    async (utilization, remaining, color) => {
      await renderLimits({
        ...status("available"),
        windows: [{ id: "quota", kind: "five-hour", label: "5-hour limit", utilization }],
      });
      await expect
        .element(page.getByRole("progressbar", { name: "5-hour limit" }))
        .toHaveAttribute("aria-valuenow", String(remaining));
      expect(
        document.querySelector('[data-slot="progress-indicator"]')?.classList.contains(color),
      ).toBe(true);
    },
  );
});
