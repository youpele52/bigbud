import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { ServerUsageTotals } from "@bigbud/contracts/server/usage.ts";
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
};

it("renders four categories and leaves reasoning inside output", () => {
  const html = renderToStaticMarkup(<UsageTokenMixCard totals={totals} />);
  for (const label of ["Input", "Cache read", "Cache write", "Output"])
    expect(html).toContain(`>${label}</span>`);
  expect(html).not.toContain(">Reasoning</span>");
  expect(html).not.toContain(">Unsplit usage</span>");
  expect(html).toContain("Input may include unseparated cache usage");
  expect(html).toContain(">100</div>");
});

it("renders the safe fallback for old-server and mismatched metadata, not numeric defaults", () => {
  const { tokenMix: _tokenMix, ...oldTotals } = totals;
  for (const value of [oldTotals, { ...totals, usedTokens: 101 }]) {
    const html = renderToStaticMarkup(<UsageTokenMixCard totals={value} />);
    expect(html).toContain(">Unsplit usage</span>");
    expect(html).toContain("Unsplit usage has no reliable category breakdown");
    expect(html).not.toContain(">Input</span>");
    expect(html).toContain(`>${value.usedTokens}</div>`);
  }
});

it("shows empty usage for zero rather than an incomplete breakdown", () => {
  const html = renderToStaticMarkup(
    <UsageTokenMixCard totals={{ ...totals, usedTokens: 0, tokenMix: undefined }} />,
  );
  expect(html).toContain("No usage yet.");
  expect(html).not.toContain("Breakdown incomplete");
});
