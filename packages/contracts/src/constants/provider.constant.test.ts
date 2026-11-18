import { describe, expect, it } from "vitest";
import {
  SELECTABLE_PROVIDER_KINDS,
  PROVIDER_KINDS,
  sortProviderKindsByDisplayName,
} from "./provider.constant";

describe("sortProviderKindsByDisplayName", () => {
  it("sorts provider kinds by their display names", () => {
    expect(sortProviderKindsByDisplayName(["pi", "codex", "claudeAgent"])).toEqual([
      "claudeAgent",
      "codex",
      "pi",
    ]);
  });

  it("derives the shared provider order", () => {
    expect(PROVIDER_KINDS).toEqual([
      "claudeAgent",
      "cliProxy",
      "codex",
      "copilot",
      "cursor",
      "devin",
      "muse",
      "opencode",
      "opencodeV2",
      "pi",
    ]);
  });
});

it("keeps legacy decode identity separate from the nine new runtime selections", () => {
  expect(PROVIDER_KINDS).toContain("opencode");
  expect(SELECTABLE_PROVIDER_KINDS).not.toContain("opencode");
  expect(SELECTABLE_PROVIDER_KINDS).toContain("opencodeV2");
  expect(SELECTABLE_PROVIDER_KINDS).toHaveLength(9);
  expect(SELECTABLE_PROVIDER_KINDS).toEqual(PROVIDER_KINDS.filter((kind) => kind !== "opencode"));
});
