import { Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { WsServerGetUsageSummaryRpc } from "@bigbud/contracts/server/rpc.usage.ts";
import type { ServerUsageSummaryResult } from "@bigbud/contracts/server/usage.ts";
import { disjointUsageMix } from "./UsageAccounting.logic";
import { UsageTokenMixCard } from "./UsageTokenMixCard";

const tokenMix = {
  inputTokens: 40,
  cacheReadTokens: 30,
  cacheWriteTokens: 10,
  outputTokens: 20,
  unclassifiedTokens: 0,
};
const summary: ServerUsageSummaryResult = {
  range: "7d",
  generatedAt: "2026-10-08T12:00:00Z",
  historyStatus: "ready",
  providerCoverage: [],
  totals: {
    usedTokens: 100,
    inputTokens: 80,
    cachedInputTokens: 30,
    outputTokens: 20,
    reasoningOutputTokens: 0,
    turnCount: 1,
    tokenMix,
    accounting: {
      source: "provider-reported",
      partial: true,
      legacy: false,
      reportedTokens: 100,
      estimatedTokens: 0,
      inputTokens: 80,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
      reasoningTokens: null,
    },
  },
  buckets: [],
  providers: [],
  models: [],
  favoriteProvider: null,
  favoriteModel: null,
  favoriteMode: null,
  streakDays: 0,
};
const decode = Schema.decodeUnknownSync(WsServerGetUsageSummaryRpc.successSchema);
const encode = Schema.encodeUnknownSync(WsServerGetUsageSummaryRpc.successSchema);
function wireWithMix(value: unknown) {
  return JSON.parse(JSON.stringify({ ...summary, totals: { ...summary.totals, tokenMix: value } }));
}

it("preserves typed valid chart detail and canonical unknowns through the actual RPC success schema", () => {
  const decoded = decode(wireWithMix(tokenMix));
  expect(decoded).toEqual(summary);
  expect(decoded.totals.accounting?.reasoningTokens).toBeNull();
  expect(disjointUsageMix(decoded.totals)).toEqual(tokenMix);
  expect(encode(decoded)).toEqual(summary);
});

it.each([
  ["absent", undefined],
  ["null", null],
  [
    "missing cache write",
    { inputTokens: 40, cacheReadTokens: 30, outputTokens: 20, unclassifiedTokens: 10 },
  ],
  ["negative", { ...tokenMix, inputTokens: -1 }],
  ["fractional", { ...tokenMix, inputTokens: 40.5 }],
  ["unsafe", { ...tokenMix, inputTokens: Number.MAX_SAFE_INTEGER + 1 }],
  ["wrong counter type", { ...tokenMix, cacheWriteTokens: "10" }],
  ["wrong object type", "invalid"],
])(
  "discards %s display detail at RPC decoding and renders the complete total as Unsplit",
  (_name, value) => {
    const decoded = decode(wireWithMix(value));
    expect(decoded.totals).not.toHaveProperty("tokenMix");
    const { tokenMix: _tokenMix, ...authoritativeTotals } = summary.totals;
    expect(decoded.totals).toEqual(authoritativeTotals);
    expect(disjointUsageMix(decoded.totals)).toEqual({
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      unclassifiedTokens: 100,
    });
    const html = renderToStaticMarkup(<UsageTokenMixCard totals={decoded.totals} />);
    expect(html).toContain(">Unsplit usage</span>");
    expect(html).toContain(">100</div>");
    expect(html).not.toContain(">Input</span>");
  },
);

it("keeps schema-valid but unreconciled detail available for the client reconciliation fallback", () => {
  const mismatched = { ...tokenMix, inputTokens: 41 };
  const decoded = decode(wireWithMix(mismatched));
  expect(decoded.totals.tokenMix).toEqual(mismatched);
  expect(disjointUsageMix(decoded.totals).unclassifiedTokens).toBe(100);
  expect(renderToStaticMarkup(<UsageTokenMixCard totals={decoded.totals} />)).toContain(
    ">Unsplit usage</span>",
  );
});

it("does not recover malformed authoritative totals, canonical fields, or other summary fields", () => {
  for (const invalid of [
    { ...summary, totals: { ...summary.totals, usedTokens: -1, tokenMix: null } },
    { ...summary, totals: { ...summary.totals, inputTokens: "80", tokenMix: null } },
    { ...summary, totals: { ...summary.totals, accounting: null, tokenMix: null } },
    {
      ...summary,
      totals: {
        ...summary.totals,
        accounting: { ...summary.totals.accounting, reasoningTokens: -1 },
        tokenMix: null,
      },
    },
    {
      ...summary,
      totals: {
        ...summary.totals,
        accounting: { ...summary.totals.accounting, source: "invalid" },
        tokenMix: null,
      },
    },
    { ...summary, totals: { ...summary.totals, turnCount: undefined, tokenMix: null } },
    { ...summary, range: "invalid" },
  ])
    expect(() => decode(JSON.parse(JSON.stringify(invalid)))).toThrow();
});

it("keeps invalid display detail strict on encoding", () => {
  expect(() => encode(wireWithMix(null))).toThrow();
  expect(() => encode(wireWithMix({ ...tokenMix, inputTokens: -1 }))).toThrow();
});
