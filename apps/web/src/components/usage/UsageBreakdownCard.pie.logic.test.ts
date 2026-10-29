import { expect, it } from "vitest";
import type { ServerUsageSummaryResult } from "@bigbud/contracts";
import type { UsageSourceMetadata } from "@bigbud/contracts/server/usage.ts";
import { buildBreakdownPieData } from "./UsageBreakdownCard.pie.logic";

function entry(
  id: string,
  source?: UsageSourceMetadata["source"],
): ServerUsageSummaryResult["providers"][number] {
  return {
    id,
    label: id,
    usedTokens: 10,
    turnCount: 1,
    ...(source
      ? {
          accounting: {
            source,
            partial: true,
            legacy: false,
            reportedTokens: source === "estimated" ? 0 : 10,
            estimatedTokens: source === "estimated" ? 10 : 0,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            reasoningTokens: null,
          },
        }
      : {}),
  };
}
const top = Array.from({ length: 4 }, (_, index) => entry(`top-${index}`, "provider-reported"));

it.each([
  [["estimated", "estimated"]],
  [["estimated", "provider-reported"]],
  [["mixed", "provider-reported"]],
  [["provider-reported", undefined]],
] as const)("folds the %j tail into a plain Other, leaving provenance to the footer", (sources) => {
  const data = buildBreakdownPieData([
    ...top,
    ...sources.map((value, index) => entry(`tail-${index}`, value)),
  ]);
  expect(data).toHaveLength(5);
  expect(data.at(-1)).toEqual({
    id: "other",
    label: "Other",
    usedTokens: 20,
    fill: "var(--chart-5)",
  });
  expect(data.map((slice) => slice.label)).toEqual(["top-0", "top-1", "top-2", "top-3", "Other"]);
});

it("omits Other when the top four cover everything", () => {
  expect(buildBreakdownPieData(top).map((slice) => slice.id)).toEqual([
    "top-0",
    "top-1",
    "top-2",
    "top-3",
  ]);
});
