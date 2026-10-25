import "../../index.css";

import type { ServerProviderUsageLimits } from "@bigbud/contracts/server/usageLimits.ts";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { useBannerDismissalStore } from "../../stores/ui/bannerDismissal.store";
import { UsageSubscriptionProviderLimits } from "./UsageSubscriptionLimits.provider";

const stale: ServerProviderUsageLimits = {
  source: "claude-agent-sdk",
  status: "stale",
  checkedAt: "2026-10-22T10:00:00Z",
  lastSuccessfulAt: "2026-10-22T09:00:00Z",
  windows: [{ id: "weekly", kind: "seven-day", label: "Weekly limit", utilization: 40 }],
};

afterEach(() => {
  document.body.innerHTML = "";
  useBannerDismissalStore.setState({ serverRunId: null, dismissed: new Set() });
});

it("closes stale limits by keyboard across polling, status changes and remounts without hiding quota data", async () => {
  const first = await render(<UsageSubscriptionProviderLimits limits={stale} />);
  const close = page.getByRole("button", {
    name: "Dismiss Claude stale subscription limits warning",
  });
  (close.element() as HTMLButtonElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(page.getByRole("progressbar", { name: "Weekly limit" })).toBeVisible();
  await first.rerender(
    <UsageSubscriptionProviderLimits
      limits={{ ...stale, checkedAt: "new-poll", lastSuccessfulAt: "2026-10-22T11:00:00Z" }}
    />,
  );
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await first.rerender(
    <UsageSubscriptionProviderLimits limits={{ ...stale, status: "available" }} />,
  );
  await first.unmount();
  await render(<UsageSubscriptionProviderLimits limits={stale} compact />);
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(page.getByText("60% remaining")).toBeVisible();
});

it("keeps providers and stale-vs-error notices independent, while repeated error copy remains closed", async () => {
  const screen = await render(<UsageSubscriptionProviderLimits limits={stale} />);
  await page
    .getByRole("button", { name: "Dismiss Claude stale subscription limits warning" })
    .click();
  await screen.rerender(
    <UsageSubscriptionProviderLimits limits={{ ...stale, source: "codex-app-server" }} />,
  );
  await expect.element(page.getByRole("alert")).toBeVisible();
  await screen.rerender(
    <UsageSubscriptionProviderLimits limits={{ ...stale, status: "error", message: "Offline" }} />,
  );
  await page.getByRole("button", { name: "Dismiss Claude subscription limits error" }).click();
  await screen.rerender(
    <UsageSubscriptionProviderLimits
      limits={{ ...stale, status: "error", message: "Still offline", checkedAt: "new-poll" }}
    />,
  );
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
});
