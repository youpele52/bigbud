import { describe, expect, it } from "vitest";

import { parseExpandedProvidersSearch } from "./-settings.providers.search";

describe("parseExpandedProvidersSearch", () => {
  it("retains exact valid provider IDs for durable direct and history navigation", () => {
    expect(
      parseExpandedProvidersSearch({ providers: ["opencode", "kilocode", "not-a-provider", 42] }),
    ).toEqual(["opencode", "kilocode"]);
    expect(parseExpandedProvidersSearch({ providers: ["kilocode"] })).toEqual(["kilocode"]);
  });

  it("normalizes an absent provider search to an empty selection", () => {
    expect(parseExpandedProvidersSearch({})).toEqual([]);
    expect(parseExpandedProvidersSearch(undefined)).toEqual([]);
  });
});
