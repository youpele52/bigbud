import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { ServerUsageSummaryResult } from "@bigbud/contracts";
import { UsageAccountingFooter } from "./UsageAccountingFooter";
import { applyUsageDisplayLabels } from "./UsagePage.labels";

const accounting = {
  source: "mixed" as const,
  partial: true,
  legacy: false,
  reportedTokens: 10,
  estimatedTokens: 5,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
};
const summary: ServerUsageSummaryResult = {
  range: "7d",
  generatedAt: "2026-10-01T00:00:00.000Z",
  historyStatus: "ready",
  providerCoverage: [],
  totals: {
    usedTokens: 15,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    turnCount: 2,
    accounting,
  },
  providers: [
    { id: "cursor", label: "Cursor", usedTokens: 15, turnCount: 2, accounting },
    {
      id: "codex",
      label: "Codex",
      usedTokens: 10,
      turnCount: 1,
      accounting: { ...accounting, source: "provider-reported" },
    },
  ],
  models: [],
  buckets: [],
  favoriteProvider: null,
  favoriteModel: null,
  favoriteMode: null,
  streakDays: 0,
};
it("discloses only providers actually estimated in the selected data", () => {
  const html = renderToStaticMarkup(<UsageAccountingFooter summary={summary} />);
  expect(html).toContain("*Estimated usage:");
  expect(html).toContain("Cursor include estimates");
  expect(html).not.toContain("Codex");
  expect(html).toContain("observable-text-v1");
  expect(html).toContain("not billing-accurate");
  expect(html).toContain("Official counts suppress overlapping estimates");
  const next = renderToStaticMarkup(
    <UsageAccountingFooter summary={{ ...summary, range: "24h", providers: [] }} />,
  );
  expect(next).not.toContain("Cursor");
});
it("names unattributed usage and discloses missing old-server metadata", () => {
  const html = renderToStaticMarkup(
    <UsageAccountingFooter
      summary={{
        ...summary,
        providers: [{ id: "unknown", label: "unknown", usedTokens: 5, turnCount: 1, accounting }],
      }}
    />,
  );
  expect(html).toContain("Unattributed usage include estimates");
  expect(html).toContain("*Unattributed usage remains included in totals");
  expect(html).not.toContain("Unknown provider");
  expect(html).not.toContain("Unknown model");
  const { accounting: _accounting, ...oldTotals } = summary.totals;
  expect(
    renderToStaticMarkup(
      <UsageAccountingFooter summary={{ ...summary, totals: oldTotals, providers: [] }} />,
    ),
  ).toContain("Source unavailable");
});

it("labels unattributed breakdowns and top cards without dropping counts", () => {
  const unknown = { id: "unknown", label: "unknown", usedTokens: 15, turnCount: 2, accounting };
  const labeled = applyUsageDisplayLabels(
    {
      ...summary,
      providers: [unknown],
      models: [unknown],
      favoriteProvider: unknown,
      favoriteModel: unknown,
    },
    [],
  );
  expect(labeled.providers[0]?.label).toBe("Unattributed usage");
  expect(labeled.models[0]?.label).toBe("Unattributed usage");
  expect(labeled.favoriteProvider?.label).toBe("Unattributed usage");
  expect(labeled.favoriteModel?.label).toBe("Unattributed usage");
  expect(labeled.totals).toEqual(summary.totals);
  expect(labeled.providers[0]?.usedTokens).toBe(15);
  expect(labeled.models[0]?.usedTokens).toBe(15);
});

it("explains missing model attribution even when its provider is known", () => {
  const html = renderToStaticMarkup(
    <UsageAccountingFooter
      summary={{
        ...summary,
        models: [{ id: "unknown", label: "unknown", usedTokens: 15, turnCount: 2, accounting }],
      }}
    />,
  );
  expect(html).toContain("*Unattributed usage remains included in totals");
  expect(html).toContain("current thread settings are not used to guess it");
  expect(renderToStaticMarkup(<UsageAccountingFooter summary={summary} />)).not.toContain(
    "Unattributed usage",
  );
});
