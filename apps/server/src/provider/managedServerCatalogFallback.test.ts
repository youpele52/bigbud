import { assert, describe, it } from "@effect/vitest";

import {
  managedServerBuiltInModels,
  modelsFromModelsDevCache,
} from "./managedServerCatalogFallback";

describe("managed server catalog fallback", () => {
  it("loads every cached sub-provider but bounds each provider to five current models", () => {
    const encoded = JSON.stringify({
      secondary: {
        id: "secondary",
        name: "Secondary",
        models: {
          one: { id: "one", name: "One", last_updated: "2026-01-01" },
        },
      },
      opencode: {
        id: "opencode",
        name: "OpenCode Zen",
        models: Object.fromEntries([
          ...Array.from({ length: 7 }, (_, index) => [
            `model-${index + 1}`,
            {
              id: `model-${index + 1}`,
              name: `Model ${index + 1}`,
              last_updated: `2026-08-0${index + 1}`,
              reasoning: index === 6,
            },
          ]),
          [
            "deprecated",
            {
              id: "deprecated",
              name: "Deprecated",
              last_updated: "2026-12-01",
              status: "deprecated",
            },
          ],
        ]),
      },
    });

    const models = modelsFromModelsDevCache(encoded);

    assert.strictEqual(models.filter((entry) => entry.subProviderID === "opencode").length, 5);
    assert.strictEqual(models.filter((entry) => entry.subProviderID === "secondary").length, 1);
    assert.strictEqual(models[0]?.slug, "model-7");
    assert.strictEqual(models[0]?.group, "OpenCode Zen");
    assert.deepStrictEqual(
      models[0]?.capabilities?.reasoningEffortLevels.map(({ value }) => value),
      ["high", "medium", "low"],
    );
    assert.isFalse(models.some((entry) => entry.slug === "deprecated"));
  });

  it("falls back safely when the provider cache is corrupt", () => {
    assert.deepStrictEqual(modelsFromModelsDevCache("{not-json"), []);
    assert.isAbove(managedServerBuiltInModels("opencode").length, 3);
    assert.isAbove(managedServerBuiltInModels("kilocode").length, 3);
    assert.strictEqual(managedServerBuiltInModels("opencode")[0]?.subProviderID, "opencode");
    assert.strictEqual(managedServerBuiltInModels("kilocode")[0]?.subProviderID, "kilo");
  });
});
