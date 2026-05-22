import { describe, expect, it } from "vitest";

import { buildBranchThreadTitle } from "./useThreadActions";

describe("buildBranchThreadTitle", () => {
  it("adds A for the first branch of an unsuffixed title", () => {
    expect(buildBranchThreadTitle("Old thread name", ["Old thread name"])).toBe(
      "Old thread name (A)",
    );
  });

  it("advances to the next suffix when branching an already suffixed thread", () => {
    expect(
      buildBranchThreadTitle("Old thread name (A)", ["Old thread name", "Old thread name (A)"]),
    ).toBe("Old thread name (B)");
  });

  it("uses the highest existing sibling suffix for the shared base title", () => {
    expect(
      buildBranchThreadTitle("Old thread name (A)", [
        "Old thread name",
        "Old thread name (A)",
        "Old thread name (C)",
      ]),
    ).toBe("Old thread name (D)");
  });

  it("continues past Z with spreadsheet-style suffixes", () => {
    expect(
      buildBranchThreadTitle("Old thread name (Z)", ["Old thread name", "Old thread name (Z)"]),
    ).toBe("Old thread name (AA)");
  });
});
