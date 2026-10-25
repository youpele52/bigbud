import "../../index.css";

import type { ServerProviderUsageLimits } from "@bigbud/contracts/server/usageLimits.ts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { UsageSubscriptionLimits } from "./UsageSubscriptionLimits";
import { expectCenteredStatuses } from "../common/CenteredStatus.browser.utils";

const api = vi.hoisted(() => ({ refreshUsageLimits: vi.fn() }));
vi.mock("../../rpc/nativeApi", () => ({ ensureNativeApi: () => ({ server: api }) }));

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
    vi.clearAllMocks();
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

  it("refreshes all subscription limits via the dedicated API with Settings-style loading and alignment", async () => {
    let finish!: () => void;
    api.refreshUsageLimits.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await renderLimits(status("available"));
    const refresh = page.getByRole("button", { name: "Refresh subscription limits" });
    const allowance = page
      .getByText("Remaining allowance", { exact: true })
      .element()
      .getBoundingClientRect();
    const button = refresh.element().getBoundingClientRect();
    expect(button.left).toBeGreaterThan(allowance.right);
    expect(
      Math.abs(button.top + button.height / 2 - (allowance.top + allowance.height / 2)),
    ).toBeLessThan(2);
    expect(button.width).toBe(20);
    await refresh.click();
    await expect.element(refresh).toBeDisabled();
    expect(refresh.element().querySelector(".animate-spin")).not.toBeNull();
    expect(api.refreshUsageLimits).toHaveBeenCalledOnce();
    finish();
    await expect.element(refresh).toBeEnabled();
    expect(refresh.element().querySelector(".animate-spin")).toBeNull();
  });

  it("recovers the refresh control after a transport failure and shows a retry message", async () => {
    api.refreshUsageLimits.mockRejectedValueOnce(new Error("offline"));
    await renderLimits(status("unavailable"));
    const refresh = page.getByRole("button", { name: "Refresh subscription limits" });
    await refresh.click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Couldn’t refresh limits. Try again.");
    await expect.element(refresh).toBeEnabled();
    api.refreshUsageLimits.mockResolvedValueOnce({ providers: [] });
    await refresh.click();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    expect(api.refreshUsageLimits).toHaveBeenCalledTimes(2);
  });

  it("keeps limit resets display-only and below limits in compact Usage", async () => {
    mounted = await render(
      <UsageSubscriptionLimits
        compact
        limits={[
          {
            ...status("available"),
            source: "codex-app-server",
            windows: [{ id: "weekly", kind: "seven-day", label: "Weekly limit", utilization: 10 }],
            manualResets: { availableCount: 2, availableExpiries: [null], detailsComplete: false },
          },
        ]}
      />,
    );
    await expect.element(page.getByText("Limit resets", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Available (2)" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByRole("button", { name: "Available (2)" })).toBeDisabled();
    await expect.element(page.getByText("No expiry", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Expiry unavailable for 1 reset")).toBeVisible();
    const quota = page
      .getByRole("progressbar", { name: "Weekly limit" })
      .element()
      .getBoundingClientRect();
    expect(
      page.getByText("Limit resets", { exact: true }).element().getBoundingClientRect().top,
    ).toBeGreaterThan(quota.bottom);
    expect(page.getByRole("button").all()).toHaveLength(2);
    await expect
      .element(page.getByRole("button", { name: "Refresh subscription limits" }))
      .toBeVisible();
  });

  it.each([
    ["pending", "Checking Claude subscription limits"],
    ["error", "Couldn't load Claude subscription limits"],
  ] as const)("renders the %s state", async (state, text) => {
    await renderLimits(status(state));
    await expect.element(page.getByText(text)).toBeInTheDocument();
    if (state === "pending") expectCenteredStatuses(document.body);
    else {
      expect(getComputedStyle(page.getByText(text).element()).textAlign).toBe("center");
      expect(document.querySelector(".animate-breathe")).toBeNull();
    }
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

  it("keeps refresh available when subscription limits are unavailable", async () => {
    await renderLimits(status("unavailable"));
    expect(document.querySelector('[data-slot="card"]')).toBeNull();
    await expect
      .element(page.getByRole("button", { name: "Refresh subscription limits" }))
      .toBeVisible();
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
    expect(document.querySelectorAll('[data-slot="tooltip-trigger"]')).toHaveLength(2);
    await page.getByRole("progressbar", { name: "Extra usage" }).hover();
    await expect.element(page.getByText("25% used · 75% left")).toBeVisible();
    await expect.element(page.getByText("Disabled", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Enabled", { exact: true })).toBeInTheDocument();
  });

  it.each([
    [0, 100, "var(--chart-1)"],
    [49.999, 50.001, "var(--chart-1)"],
    [50, 50, "var(--chart-3)"],
    [79.999, 20.001, "var(--chart-3)"],
    [80, 20, "var(--chart-4)"],
    [100, 0, "var(--chart-4)"],
  ] as const)(
    "shows %s%% used as %s%% remaining with the correct severity",
    async (utilization, remaining, color) => {
      await renderLimits({
        ...status("available"),
        windows: [{ id: "quota", kind: "five-hour", label: "5-hour limit", utilization }],
      });
      await expect
        .element(page.getByRole("progressbar", { name: "5-hour limit" }))
        .toHaveAttribute("aria-valuenow", String(100 - utilization));
      expect(
        Number(
          page
            .getByRole("progressbar", { name: "5-hour limit" })
            .element()
            .getAttribute("aria-valuenow"),
        ),
      ).toBeCloseTo(remaining);
      expect(
        (document.querySelector('[data-slot="progress-indicator"]') as HTMLElement).style
          .backgroundColor,
      ).toBe(color);
    },
  );
});
