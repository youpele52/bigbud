import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { checkCodexProviderStatus } from "./Provider";
import { mockSpawnerLayer, withTempCodexHome } from "../ProviderRegistry.test.helpers";
import { ServerSettingsService } from "../../../ws/serverSettings";

const discoveredModel = {
  slug: "discovered-model",
  name: "Discovered Model",
  isCustom: false,
  capabilities: {
    reasoningEffortLevels: [{ value: "high", label: "High", isDefault: true }],
    supportsFastMode: false,
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  },
} as const;

const successfulCommand = (args: ReadonlyArray<string>) => {
  const joined = args.join(" ");
  if (joined === "--version" || joined === "login status") {
    return {
      stdout: joined === "--version" ? "codex 1.0.0\n" : "Logged in\n",
      stderr: "",
      code: 0,
    };
  }
  throw new Error(`Unexpected args: ${joined}`);
};

describe("checkCodexProviderStatus model discovery", () => {
  it.effect("uses a successful empty discovery result instead of fallback models", () =>
    Effect.gen(function* () {
      yield* withTempCodexHome();
      const status = yield* checkCodexProviderStatus(() =>
        Effect.succeed({
          account: { type: "unknown" as const, planType: null, sparkEnabled: false },
          skills: [],
          models: [],
        }),
      );

      assert.deepStrictEqual(
        status.models.map((model) => model.slug),
        ["custom-model"],
      );
      assert.deepStrictEqual(status.models[0]?.capabilities?.reasoningEffortLevels, []);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ServerSettingsService.layerTest({
            providers: { codex: { customModels: ["custom-model"] } },
          }),
          mockSpawnerLayer(successfulCommand),
        ),
      ),
    ),
  );

  it.effect("does not expose effort support on unverified fallback models", () =>
    Effect.gen(function* () {
      yield* withTempCodexHome();
      const status = yield* checkCodexProviderStatus();

      assert.strictEqual(status.models.length > 0, true);
      assert.strictEqual(
        status.models.every((model) => model.capabilities?.reasoningEffortLevels.length === 0),
        true,
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ServerSettingsService.layerTest(),
          mockSpawnerLayer(successfulCommand),
        ),
      ),
    ),
  );

  it.effect("deduplicates configured models already present in discovery", () =>
    Effect.gen(function* () {
      yield* withTempCodexHome();
      const status = yield* checkCodexProviderStatus(() =>
        Effect.succeed({
          account: { type: "unknown" as const, planType: null, sparkEnabled: false },
          skills: [],
          models: [discoveredModel],
        }),
      );

      assert.deepStrictEqual(status.models, [discoveredModel]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ServerSettingsService.layerTest({
            providers: { codex: { customModels: ["discovered-model"] } },
          }),
          mockSpawnerLayer(successfulCommand),
        ),
      ),
    ),
  );

  it.effect("keeps discovered capabilities and gives custom models no effort support", () =>
    Effect.gen(function* () {
      yield* withTempCodexHome();
      const status = yield* checkCodexProviderStatus(() =>
        Effect.succeed({
          account: { type: "unknown" as const, planType: null, sparkEnabled: false },
          skills: [],
          models: [discoveredModel],
        }),
      );

      assert.deepStrictEqual(
        status.models.map((model) => model.slug),
        ["discovered-model", "custom-model"],
      );
      assert.deepStrictEqual(status.models[0]?.capabilities?.reasoningEffortLevels, [
        { value: "high", label: "High", isDefault: true },
      ]);
      assert.deepStrictEqual(status.models[1]?.capabilities?.reasoningEffortLevels, []);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ServerSettingsService.layerTest({
            providers: { codex: { customModels: ["custom-model"] } },
          }),
          mockSpawnerLayer(successfulCommand),
        ),
      ),
    ),
  );
});
