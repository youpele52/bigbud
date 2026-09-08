import type { ServerProviderModel } from "@bigbud/contracts/server/server.providers.ts";
import { assert, describe, it } from "@effect/vitest";

import {
  CodexModelSelectionError,
  resolveCodexModelSelection,
} from "./codexAppServerManager.modelSelection";

function model(
  slug: string,
  efforts: ReadonlyArray<{ value: string; isDefault?: boolean }>,
): ServerProviderModel {
  return {
    slug,
    name: slug,
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: efforts.map((effort) => ({
        ...effort,
        label: effort.value,
      })),
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  };
}

const catalog = [
  model("gpt-current", [
    { value: "medium", isDefault: true },
    { value: "max" },
    { value: "ultra" },
    { value: "future-depth" },
  ]),
  model("gpt-next", [{ value: "high", isDefault: true }, { value: "ultra" }]),
];

function expectSelectionError(
  operation: () => unknown,
  kind: CodexModelSelectionError["kind"],
): void {
  try {
    operation();
    assert.fail("Expected Codex model selection to fail.");
  } catch (error) {
    assert.instanceOf(error, CodexModelSelectionError);
    assert.strictEqual(error.kind, kind);
  }
}

describe("resolveCodexModelSelection", () => {
  it("preserves exact advertised dynamic efforts", () => {
    for (const effort of ["max", "ultra", "future-depth"]) {
      assert.deepStrictEqual(
        resolveCodexModelSelection({
          catalog,
          current: undefined,
          model: "gpt-current",
          effort,
          modelExplicitlyRequested: true,
        }),
        { model: "gpt-current", effort },
      );
    }
  });

  it("rejects unsupported efforts with exact case-sensitive membership", () => {
    for (const effort of ["Ultra", "xhigh", " ultra "]) {
      expectSelectionError(
        () =>
          resolveCodexModelSelection({
            catalog,
            current: undefined,
            model: "gpt-current",
            effort,
            modelExplicitlyRequested: true,
          }),
        "unsupported-effort",
      );
    }
  });

  it("distinguishes unavailable and loaded-empty catalogs", () => {
    expectSelectionError(
      () =>
        resolveCodexModelSelection({
          catalog: undefined,
          current: { model: "gpt-current", effort: "max" },
          model: undefined,
          effort: "ultra",
          modelExplicitlyRequested: false,
        }),
      "catalog-unavailable",
    );
    expectSelectionError(
      () =>
        resolveCodexModelSelection({
          catalog: [],
          current: undefined,
          model: "gpt-current",
          effort: undefined,
          modelExplicitlyRequested: true,
        }),
      "unknown-model",
    );
  });

  it("uses the current model when the requested model is absent", () => {
    assert.deepStrictEqual(
      resolveCodexModelSelection({
        catalog,
        current: { model: "gpt-current", effort: "max" },
        model: undefined,
        effort: undefined,
        modelExplicitlyRequested: false,
      }),
      { model: "gpt-current", effort: "max" },
    );
  });

  it("inherits effort only on the same model", () => {
    assert.deepStrictEqual(
      resolveCodexModelSelection({
        catalog,
        current: { model: "gpt-current", effort: "max" },
        model: "gpt-next",
        effort: undefined,
        modelExplicitlyRequested: true,
      }),
      { model: "gpt-next", effort: "high" },
    );
  });

  it("omits effort on a model switch without a catalog", () => {
    assert.deepStrictEqual(
      resolveCodexModelSelection({
        catalog: undefined,
        current: { model: "gpt-current", effort: "max" },
        model: "gpt-next",
        effort: undefined,
        modelExplicitlyRequested: true,
      }),
      { model: "gpt-next", effort: undefined },
    );
  });
});
