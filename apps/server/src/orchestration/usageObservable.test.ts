import { expect, it } from "vitest";
import { estimateObservableTokens } from "./usageObservable.ts";

it("counts Unicode codepoints per final stored message, including empty zero", () => {
  expect(estimateObservableTokens("")).toBe(0);
  expect(estimateObservableTokens("😀😀😀😀")).toBe(1);
  expect(estimateObservableTokens("😀😀😀😀😀")).toBe(2);
  expect(estimateObservableTokens(["ab", "cd"].join(""))).toBe(1);
  expect(estimateObservableTokens("a\u0301中")).toBe(1);
});
