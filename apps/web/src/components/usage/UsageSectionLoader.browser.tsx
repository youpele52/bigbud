import "../../index.css";

import type { ServerUsageSummaryResult } from "@bigbud/contracts/server/usage.ts";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { UsageSectionLoader } from "./UsageSectionLoader";
import { UsageTokenUsageCard } from "./UsageTokenUsageCard";
import { fillUsageTimeline } from "./UsagePage.buckets.logic";

const totals = {
  usedTokens: 100,
  inputTokens: 60,
  cachedInputTokens: 10,
  outputTokens: 20,
  reasoningOutputTokens: 10,
  turnCount: 1,
  tokenMix: {
    inputTokens: 35,
    cacheReadTokens: 30,
    cacheWriteTokens: 10,
    outputTokens: 20,
    unclassifiedTokens: 5,
  },
};
const summary: ServerUsageSummaryResult = {
  range: "7d",
  generatedAt: "2026-11-07T12:00:00Z",
  historyStatus: "ready",
  providerCoverage: [],
  totals,
  buckets: [{ ...totals, bucketStart: "2026-11-07T00:00:00Z" }],
  providers: [],
  models: [],
  favoriteProvider: null,
  favoriteModel: null,
  favoriteMode: null,
  streakDays: 1,
};
let mounted: Awaited<ReturnType<typeof render>> | undefined;

describe("Usage section loader", () => {
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
    await page.viewport(1280, 900);
  });

  it.each([800, 1280])("reserves the responsive Activity footprint at %ipx", async (width) => {
    await page.viewport(width, 1200);
    mounted = await render(<UsageSectionLoader activity label="Loading usage activity" />);
    const loader = mounted.getByRole("status").element();
    const bounds = loader.getBoundingClientRect();
    expect(bounds.height).toBeGreaterThanOrEqual(width < 1024 ? 848 : 432);
    expect(loader.closest('[aria-busy="true"]')).toBeNull();
    const logo = loader.querySelector(".animate-pulse-slow")!.getBoundingClientRect();
    expect(logo.left + logo.width / 2).toBeCloseTo(bounds.left + bounds.width / 2, 0);
    expect(logo.top + logo.height / 2).toBeCloseTo(bounds.top + bounds.height / 2, 0);
    const reservedHeight = loader.closest('[data-slot="card"]')!.getBoundingClientRect().height;
    await mounted.rerender(
      <UsageTokenUsageCard summary={summary} timeline={fillUsageTimeline(summary)} />,
    );
    const card = mounted
      .getByRole("complementary", { name: "Activity details" })
      .element()
      .closest('[data-slot="card"]')!;
    const loadedHeight = card.getBoundingClientRect().height;
    // Token types can have up to five rows; allow a small difference for fewer rows.
    expect(Math.abs(loadedHeight - reservedHeight)).toBeLessThan(100);
    expect(document.querySelector(".animate-pulse-slow")).toBeNull();
  });
});
