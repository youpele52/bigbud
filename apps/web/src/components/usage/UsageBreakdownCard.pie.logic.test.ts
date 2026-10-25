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
  [["estimated", "estimated"], "estimated", "Other · Estimated"],
  [["estimated", "provider-reported"], "mixed", "Other · Mixed"],
  [["mixed", "provider-reported"], "mixed", "Other · Mixed"],
  [["provider-reported", "provider-reported"], "provider-reported", "Other"],
] as const)(
  "preserves %j provenance in the shared tooltip/legend label",
  (sources, source, label) => {
    expect(
      buildBreakdownPieData([
        ...top,
        ...sources.map((value, index) => entry(`tail-${index}`, value)),
      ]).at(-1),
    ).toMatchObject({ id: "other", source, label, usedTokens: 20 });
  },
);
it("does not disguise missing provenance or hide known estimated contributors", () => {
  expect(
    buildBreakdownPieData([...top, entry("unknown"), entry("estimated", "estimated")]).at(-1)
      ?.label,
  ).toBe("Other · Estimated · Source unavailable");
  expect(buildBreakdownPieData([...top, entry("unknown")]).at(-1)?.label).toBe(
    "Other · Source unavailable",
  );
});
