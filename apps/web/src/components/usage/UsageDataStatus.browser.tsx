import "../../index.css";

import { type ServerUsageSummaryResult } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { UsageDataStatus } from "./UsageDataStatus";

const SUMMARY = {
  range: "7d",
  generatedAt: "2026-07-25T00:00:00.000Z",
  historyStatus: "ready",
  providerCoverage: [{ provider: "cursor", status: "unavailable", reason: "Usage unavailable" }],
  totals: {
    usedTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    turnCount: 0,
  },
  buckets: [],
  providers: [],
  models: [],
  favoriteProvider: null,
  favoriteModel: null,
  favoriteMode: null,
  streakDays: 0,
} satisfies ServerUsageSummaryResult;

async function mountUsageDataStatus() {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(<UsageDataStatus summary={SUMMARY} />, { container: host });

  return {
    async cleanup() {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("UsageDataStatus", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps the unavailable usage warning dismissed when the page remounts", async () => {
    const firstMount = await mountUsageDataStatus();
    await page.getByLabelText("Dismiss usage availability warning").click();
    await expect
      .element(page.getByText("Usage unavailable for some providers"))
      .not.toBeInTheDocument();
    await firstMount.cleanup();

    const secondMount = await mountUsageDataStatus();
    await expect
      .element(page.getByText("Usage unavailable for some providers"))
      .not.toBeInTheDocument();
    await secondMount.cleanup();
  });
});
