import { describe, expect, it } from "vitest";

import { getRoutableModelSelection } from "./selection-helpers.models";

it("does not route a saved KiloCode selection through another provider", () => {
  const selection = { provider: "kilocode", model: "legacy", options: { original: true } } as const;
  expect(getRoutableModelSelection(selection)).toBeNull();
  expect(selection).toEqual({ provider: "kilocode", model: "legacy", options: { original: true } });
});

it("also excludes the retired OpenCode V1 runtime", () => {
  expect(getRoutableModelSelection({ provider: "opencode", model: "legacy" })).toBeNull();
});

describe("current selections", () => {
  it("preserves current identity and options", () => {
    const selection = { provider: "codex", model: "current", options: { fastMode: true } } as const;
    expect(getRoutableModelSelection(selection)).toBe(selection);
  });
});
