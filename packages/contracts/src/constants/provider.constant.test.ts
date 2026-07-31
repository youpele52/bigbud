import { describe, expect, it } from "vitest";
import { PROVIDER_KINDS, sortProviderKindsByDisplayName } from "./provider.constant";

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
      "kilocode",
      "opencode",
      "pi",
    ]);
  });
});
