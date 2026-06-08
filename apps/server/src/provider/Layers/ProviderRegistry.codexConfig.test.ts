import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  hasCustomModelProvider,
  parseAuthStatusFromOutput,
  readCodexConfigModelProvider,
} from "./Codex/Provider";
import { ServerSettingsService } from "../../ws/serverSettings";

import { withTempCodexHome } from "./ProviderRegistry.test.helpers";

// ── parseAuthStatusFromOutput pure tests ─────────────────────────────

describe("parseAuthStatusFromOutput", () => {
  it("exit code 0 with no auth markers is ready", () => {
    const parsed = parseAuthStatusFromOutput({ stdout: "OK\n", stderr: "", code: 0 });
    assert.strictEqual(parsed.status, "ready");
    assert.strictEqual(parsed.auth.status, "authenticated");
  });

  it("JSON with authenticated=false is unauthenticated", () => {
    const parsed = parseAuthStatusFromOutput({
      stdout: '[{"authenticated":false}]\n',
      stderr: "",
      code: 0,
    });
    assert.strictEqual(parsed.status, "error");
    assert.strictEqual(parsed.auth.status, "unauthenticated");
  });

  it("JSON without auth marker is warning", () => {
    const parsed = parseAuthStatusFromOutput({
      stdout: '[{"ok":true}]\n',
      stderr: "",
      code: 0,
    });
    assert.strictEqual(parsed.status, "warning");
    assert.strictEqual(parsed.auth.status, "unknown");
  });
});

// ── readCodexConfigModelProvider effect tests ─────────────────────────

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsService.layerTest()))(
  "ProviderRegistry",
  (it) => {
    describe("readCodexConfigModelProvider", () => {
      it.effect("returns undefined when config file does not exist", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          assert.strictEqual(yield* readCodexConfigModelProvider(), undefined);
        }),
      );

      it.effect("returns undefined when config has no model_provider key", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome('model = "gpt-5-codex"\n');
          assert.strictEqual(yield* readCodexConfigModelProvider(), undefined);
        }),
      );

      it.effect("returns the provider when model_provider is set at top level", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome('model = "gpt-5-codex"\nmodel_provider = "portkey"\n');
          assert.strictEqual(yield* readCodexConfigModelProvider(), "portkey");
        }),
      );

      it.effect("returns openai when model_provider is openai", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome('model_provider = "openai"\n');
          assert.strictEqual(yield* readCodexConfigModelProvider(), "openai");
        }),
      );

      it.effect("ignores model_provider inside section headers", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome(
            [
              'model = "gpt-5-codex"',
              "",
              "[model_providers.portkey]",
              'base_url = "https://api.portkey.ai/v1"',
              'model_provider = "should-be-ignored"',
              "",
            ].join("\n"),
          );
          assert.strictEqual(yield* readCodexConfigModelProvider(), undefined);
        }),
      );

      it.effect("handles comments and whitespace", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome(
            [
              "# This is a comment",
              "",
              '  model_provider = "azure"  ',
              "",
              "[profiles.deep-review]",
              'model = "gpt-5-pro"',
            ].join("\n"),
          );
          assert.strictEqual(yield* readCodexConfigModelProvider(), "azure");
        }),
      );

      it.effect("handles single-quoted values in TOML", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome("model_provider = 'mistral'\n");
          assert.strictEqual(yield* readCodexConfigModelProvider(), "mistral");
        }),
      );
    });

    // ── hasCustomModelProvider tests ────────────────────────────────────

    describe("hasCustomModelProvider", () => {
      it.effect("returns false when no config file exists", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          assert.strictEqual(yield* hasCustomModelProvider, false);
        }),
      );

      it.effect("returns false when model_provider is not set", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome('model = "gpt-5-codex"\n');
          assert.strictEqual(yield* hasCustomModelProvider, false);
        }),
      );

      it.effect("returns false when model_provider is openai", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome('model_provider = "openai"\n');
          assert.strictEqual(yield* hasCustomModelProvider, false);
        }),
      );

      it.effect("returns true when model_provider is portkey", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome('model_provider = "portkey"\n');
          assert.strictEqual(yield* hasCustomModelProvider, true);
        }),
      );

      it.effect("returns true when model_provider is azure", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome('model_provider = "azure"\n');
          assert.strictEqual(yield* hasCustomModelProvider, true);
        }),
      );

      it.effect("returns true when model_provider is ollama", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome('model_provider = "ollama"\n');
          assert.strictEqual(yield* hasCustomModelProvider, true);
        }),
      );

      it.effect("returns true when model_provider is a custom proxy", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome('model_provider = "my-company-proxy"\n');
          assert.strictEqual(yield* hasCustomModelProvider, true);
        }),
      );
    });
  },
);
