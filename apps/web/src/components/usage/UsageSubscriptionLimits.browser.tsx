import "../../index.css";

import type { ServerProviderUsageLimits } from "@bigbud/contracts/server/usageLimits.ts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { UsageSubscriptionLimits } from "./UsageSubscriptionLimits";

const checkedAt = "2026-09-06T12:00:00.000Z";

async function renderLimits(limits: ServerProviderUsageLimits) {
  const host = document.createElement("div");
  document.body.append(host);
  return render(<UsageSubscriptionLimits limits={limits} />, { container: host });
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
  afterEach(() => {
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
    await expect.element(page.getByText("42%")).toBeInTheDocument();
    await expect.element(page.getByText("25 of 100 USD used")).toBeInTheDocument();
  });

  it.each([
    ["pending", "Checking Claude subscription limits..."],
    ["unavailable", "Claude subscription limits are unavailable for this account."],
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
    await expect.element(page.getByText("75%")).toBeInTheDocument();
  });

  it("keeps the unavailable title and description in one dismissible banner", async () => {
    await renderLimits(status("unavailable"));

    const alert = page.getByRole("alert");
    await expect
      .element(alert)
      .toHaveTextContent(
        "Claude subscription limitsClaude subscription limits are unavailable for this account.",
      );
    expect(document.querySelector("h2")).toBeNull();

    await page.getByLabelText("Dismiss Claude subscription limits").click();
    await expect.element(alert).not.toBeInTheDocument();

    document.body.innerHTML = "";
    await renderLimits(status("unavailable"));
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  });
});
