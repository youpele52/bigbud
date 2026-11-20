import { describe, expect, it } from "vitest";

import {
  compareCodePointOrder,
  insertRankedName,
  nameRankFields,
  normalizeNameRankQuery,
  scoreNameRankCandidate,
  type NameRankCandidate,
  type RankedName,
} from "./nameRank";
import fixtures from "./nameRank.fixtures.json" with { type: "json" };

interface FixtureCase {
  readonly name: string;
  readonly query: string;
  readonly limit: number;
  readonly entries: ReadonlyArray<{ readonly path: string; readonly kind: string }>;
  readonly expected: ReadonlyArray<{ readonly path: string; readonly score: number }>;
}

function rank(fixture: FixtureCase) {
  const query = normalizeNameRankQuery(fixture.query);
  const ranked: RankedName<NameRankCandidate>[] = [];
  for (const entry of fixture.entries) {
    const candidate: NameRankCandidate = {
      path: entry.path,
      kind: entry.kind === "directory" ? "directory" : "file",
      ...nameRankFields(entry.path),
    };
    const score = scoreNameRankCandidate(candidate, query);
    if (score !== null) insertRankedName(ranked, { entry: candidate, score }, fixture.limit);
  }
  return ranked.map(({ entry, score }) => ({ path: entry.path, score }));
}

describe("shared fuzzy name-ranking fixtures (also run by the Rust engine)", () => {
  const cases = fixtures.cases as ReadonlyArray<FixtureCase>;

  it("has cases for every match class and the alignment edge cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(9);
  });

  for (const fixture of cases) {
    it(fixture.name, () => {
      expect(rank(fixture)).toEqual(fixture.expected);
    });
  }
});

describe("compareCodePointOrder", () => {
  it("orders by code point like Rust strings, unlike localeCompare", () => {
    expect(["a", "_", "B", "é"].toSorted(compareCodePointOrder)).toEqual(["B", "_", "a", "é"]);
    // A non-BMP character sorts after U+FFFD in code point order (UTF-16 units would not).
    expect(compareCodePointOrder("😀", "�")).toBeGreaterThan(0);
    expect(compareCodePointOrder("ab", "abc")).toBeLessThan(0);
    expect(compareCodePointOrder("abc", "abc")).toBe(0);
  });
});
