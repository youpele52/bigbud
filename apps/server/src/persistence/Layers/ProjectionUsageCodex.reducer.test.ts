import { expect, it } from "vitest";
import { canonicalUsage } from "../../provider/Layers/ProviderUsageAccounting.canonical.ts";
import { reduceCodexUsage } from "./ProjectionUsageCodex.reducer.ts";

function observation(total: number, last = 10) {
  const counters = (value: number) =>
    canonicalUsage({
      basis: "fixture",
      inputTokens: value,
      outputTokens: 0,
      reportedTotal: value,
    })!;
  return { nativeThreadId: "native", total: counters(total), last: counters(last) };
}

it("accumulates multiple responses and rejects duplicates across durable restart", () => {
  const first = reduceCodexUsage(undefined, "turn", observation(100))!;
  expect(first.amount.subtotal).toBe(10);
  const second = reduceCodexUsage(first, "turn", observation(120, 20))!;
  expect(second.amount.subtotal).toBe(30);
  const restarted = JSON.parse(JSON.stringify(second));
  expect(reduceCodexUsage(restarted, "turn", observation(120, 20))).toBeUndefined();
  expect(reduceCodexUsage(restarted, "turn", observation(130))?.amount.subtotal).toBe(40);
});
it("never makes an unseen late decrease chargeable again (100,120,110,130)", () => {
  let state = reduceCodexUsage(undefined, "turn", observation(100, 10))!;
  state = reduceCodexUsage(state, "turn", observation(120, 20))!;
  expect(reduceCodexUsage(state, "turn", observation(110, 10))).toBeUndefined();
  state = JSON.parse(JSON.stringify(state));
  expect(reduceCodexUsage(state, "turn", observation(130, 10))?.amount.subtotal).toBe(40);
});
it("keeps high water across ambiguous reset and restart, favoring partial undercount", () => {
  const first = reduceCodexUsage(undefined, "turn", observation(100))!;
  expect(reduceCodexUsage(first, "turn", observation(5, 5))).toBeUndefined();
  const restarted = JSON.parse(JSON.stringify(first));
  expect(reduceCodexUsage(restarted, "turn", observation(12, 7))).toBeUndefined();
  expect(reduceCodexUsage(restarted, "turn", observation(105, 5))?.amount.subtotal).toBe(15);
  expect(
    reduceCodexUsage(restarted, "turn", { ...observation(5, 5), nativeThreadId: "other" }),
  ).toBeUndefined();
});
it("counts only last for unsafe new-turn gaps and seeds missing state without recounting last", () => {
  const first = reduceCodexUsage(undefined, "old", observation(100))!;
  const baseline = reduceCodexUsage(first, "old", observation(120, 20))!;
  const second = reduceCodexUsage(baseline, "new", observation(160, 10))!;
  expect(second.amount.subtotal).toBe(10);
  expect(second.amount.completeness).toBe("partial");
  const recovered = reduceCodexUsage(undefined, "old", observation(200), first.amount)!;
  expect(recovered.amount.subtotal).toBe(10);
  expect(reduceCodexUsage(recovered, "old", observation(205, 5))?.amount.subtotal).toBe(15);
});

it("keeps active checkpoint size constant over a long turn", () => {
  let state = reduceCodexUsage(undefined, "turn", observation(100))!;
  for (let total = 101; total <= 10100; total++)
    state = reduceCodexUsage(state, "turn", observation(total, 1))!;
  expect(state.amount.subtotal).toBe(10010);
  expect(JSON.stringify(state).length).toBeLessThan(1000);
  expect(reduceCodexUsage(state, "turn", observation(100, 10))).toBeUndefined();
});
