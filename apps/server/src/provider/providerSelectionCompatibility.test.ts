import { describe, expect, test } from "vitest";

import {
  inventoryLearningJobSelection,
  inventoryProviderSessionBinding,
  inventoryProviderSelection,
  normalizeRemovedProviderSelectionsForValidation,
  quarantineProviderSelection,
} from "./providerSelectionCompatibility.ts";

describe("provider selection compatibility", () => {
  test("keeps a removed provider lossless and marks it for reselection", () => {
    const selection = {
      provider: "cliProxy",
      model: "legacy-model",
      options: { stale: true },
    };

    expect(
      inventoryProviderSelection({ selection, currentProviders: ["codex", "claudeAgent"] }),
    ).toMatchObject({
      provider: "cliProxy",
      model: "legacy-model",
      disposition: "requires-reselection",
    });
    expect(quarantineProviderSelection({ selection, currentProviders: ["codex"] })).not.toBeNull();
  });

  test("does not map a removed provider session to Codex", () => {
    const inventory = inventoryProviderSessionBinding({
      provider: "cliProxy",
      model: "legacy-model",
      resumeCursor: { cursor: "keep" },
      currentProviders: ["codex"],
    });

    expect(inventory.disposition).toBe("requires-reselection");
    expect(inventory.provider).toBe("cliProxy");
    expect(inventory.selection.options).toEqual({ cursor: "keep" });
  });

  test("marks learning selections for reselection instead of scheduling Codex", () => {
    expect(
      inventoryLearningJobSelection({
        provider: "cliProxy",
        model: "legacy-model",
        selection: { provider: "cliProxy", model: "legacy-model" },
        currentProviders: ["codex"],
      }),
    ).toMatchObject({ disposition: "requires-reselection", provider: "cliProxy" });
  });

  test("normalizes only validation copies of removed-provider selections", () => {
    const persisted = {
      payload: {
        defaultModelSelection: {
          provider: "removedProvider",
          model: "legacy-model",
          options: { legacy: true },
        },
      },
    };

    expect(normalizeRemovedProviderSelectionsForValidation(persisted)).toEqual({
      payload: {
        defaultModelSelection: { provider: "codex", model: "legacy-model" },
      },
    });
    expect(persisted.payload.defaultModelSelection.provider).toBe("removedProvider");
  });
});
