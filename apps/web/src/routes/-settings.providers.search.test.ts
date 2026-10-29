import { describe, expect, it } from "vitest";

import { parseExpandedProvidersSearch } from "./-settings.providers.search";

describe("parseExpandedProvidersSearch", () => {
  it("retains exact valid provider IDs for durable direct and history navigation", () => {
    expect(parseExpandedProvidersSearch({ providers: ["opencode", "not-a-provider", 42] })).toEqual(
      ["opencode"],
    );
    expect(parseExpandedProvidersSearch({ providers: ["kilocode"] })).toEqual([]);
  });

  it("normalizes an absent provider search to an empty selection", () => {
    expect(parseExpandedProvidersSearch({})).toEqual([]);
    expect(parseExpandedProvidersSearch(undefined)).toEqual([]);
  });
});
