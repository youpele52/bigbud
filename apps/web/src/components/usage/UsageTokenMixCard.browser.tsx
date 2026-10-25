import "../../index.css";

import type { ServerUsageTotals } from "@bigbud/contracts/server/usage.ts";
import { page } from "vitest/browser";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { UsageTokenMixCard } from "./UsageTokenMixCard";

const totals: ServerUsageTotals = {
  usedTokens: 100,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  turnCount: 1,
  tokenMix: {
    inputTokens: 40,
    cacheReadTokens: 30,
    cacheWriteTokens: 10,
    outputTokens: 20,
    unclassifiedTokens: 0,
  },
  accounting: {
    source: "mixed",
    partial: true,
    legacy: false,
    reportedTokens: 95,
    estimatedTokens: 5,
    inputTokens: 80,
    outputTokens: 20,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
  },
};

let mounted: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = "";
});

it("draws four actual donut sectors with canonical nulls and reconciles to overview", async () => {
  mounted = await render(<UsageTokenMixCard totals={totals} />);
  for (const label of ["Input", "Cache read", "Cache write", "Output"]) {
    await expect.element(page.getByText(label, { exact: true })).toBeVisible();
  }
  await expect.element(page.getByText("100", { exact: true })).toBeVisible();
  expect(document.body.textContent).toContain("Input may include unseparated cache usage");
  expect(document.body.textContent).not.toContain("Breakdown incomplete");
  expect(document.body.textContent).not.toContain("Unsplit usage");
  await expect.poll(() => document.querySelectorAll(".recharts-pie-sector").length).toBe(4);
});

it("keeps known and unsplit contributions visible together", async () => {
  mounted = await render(
    <UsageTokenMixCard
      totals={{
        ...totals,
        usedTokens: 105,
        tokenMix: { ...totals.tokenMix!, unclassifiedTokens: 5 },
      }}
    />,
  );
  await expect.element(page.getByText("Unsplit usage", { exact: true })).toBeVisible();
  await expect.element(page.getByText("105", { exact: true })).toBeVisible();
  await expect.poll(() => document.querySelectorAll(".recharts-pie-sector").length).toBe(5);
});

it("renders older-server totals as unsplit instead of an empty chart or fabricated detail", async () => {
  const { tokenMix: _tokenMix, ...oldTotals } = totals;
  mounted = await render(<UsageTokenMixCard totals={oldTotals} />);
  await expect.element(page.getByText("Unsplit usage", { exact: true })).toBeVisible();
  await expect.element(page.getByText("100", { exact: true }).first()).toBeVisible();
  expect(document.body.textContent).toContain("Unsplit usage has no reliable category breakdown");
  await expect.poll(() => document.querySelectorAll(".recharts-pie-sector").length).toBe(1);
});
