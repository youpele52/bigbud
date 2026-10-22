import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { MonitorCollectionStatus } from "@bigbud/contracts/system-monitor/types";

import { useBannerDismissalStore } from "../../stores/ui/bannerDismissal.store";
import { ResourceCollectionStatus } from "./ResourceCollectionStatus";

const failed: MonitorCollectionStatus = {
  state: "failed",
  attempts: 2,
  retryAfterMs: 2500,
  reason: "Sensor failed",
  epoch: 4,
};
afterEach(() => {
  document.body.innerHTML = "";
  useBannerDismissalStore.setState({ dismissed: new Set(), serverRunId: null });
});

it("preserves retry, and closing stays closed across attempts, recovery and remounts", async () => {
  const retry = vi.fn();
  const first = await render(<ResourceCollectionStatus status={failed} onRetry={retry} />);
  await page.getByRole("button", { name: "Retry collection" }).click();
  expect(retry).toHaveBeenCalledOnce();
  await page.getByRole("button", { name: "Dismiss resource collection status" }).click();
  expect(retry).toHaveBeenCalledOnce();
  await first.rerender(
    <ResourceCollectionStatus
      status={{ ...failed, state: "retrying", attempts: 3, epoch: 5 }}
      onRetry={retry}
    />,
  );
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  await first.rerender(
    <ResourceCollectionStatus status={{ ...failed, state: "healthy" }} onRetry={retry} />,
  );
  await first.unmount();
  await render(<ResourceCollectionStatus status={failed} onRetry={retry} />);
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
});
