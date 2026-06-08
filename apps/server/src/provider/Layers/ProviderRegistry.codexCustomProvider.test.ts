import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { checkCodexProviderStatus } from "./Codex/Provider";
import { ServerSettingsService } from "../../ws/serverSettings";

import {
  failingSpawnerLayer,
  mockSpawnerLayer,
  withTempCodexHome,
} from "./ProviderRegistry.test.helpers";

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsService.layerTest()))(
  "ProviderRegistry",
  (it) => {
    describe("checkCodexProviderStatus with custom model provider", () => {
      it.effect(
        "skips auth probe and returns ready when a custom model provider is configured",
        () =>
          Effect.gen(function* () {
            yield* withTempCodexHome(
              [
                'model_provider = "portkey"',
                "",
                "[model_providers.portkey]",
                'base_url = "https://api.portkey.ai/v1"',
                'env_key = "PORTKEY_API_KEY"',
              ].join("\n"),
            );
            const status = yield* checkCodexProviderStatus();
            assert.strictEqual(status.provider, "codex");
            assert.strictEqual(status.status, "ready");
            assert.strictEqual(status.installed, true);
            assert.strictEqual(status.auth.status, "unknown");
            assert.strictEqual(
              status.message,
              "Using a custom Codex model provider; OpenAI login check skipped.",
            );
          }).pipe(
            Effect.provide(
              // The spawner only handles --version; if the test attempts
              // "login status" the throw proves the auth probe was NOT skipped.
              mockSpawnerLayer((args) => {
                const joined = args.join(" ");
                if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
                throw new Error(`Auth probe should have been skipped but got args: ${joined}`);
              }),
            ),
          ),
      );

      it.effect("still reports error when codex CLI is missing even with custom provider", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome(
            [
              'model_provider = "portkey"',
              "",
              "[model_providers.portkey]",
              'base_url = "https://api.portkey.ai/v1"',
              'env_key = "PORTKEY_API_KEY"',
            ].join("\n"),
          );
          const status = yield* checkCodexProviderStatus();
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, false);
        }).pipe(Effect.provide(failingSpawnerLayer("spawn codex ENOENT"))),
      );
    });

    describe("checkCodexProviderStatus with openai model provider", () => {
      it.effect("still runs auth probe when model_provider is openai", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome('model_provider = "openai"\n');
          const status = yield* checkCodexProviderStatus();
          // The auth probe runs and sees "not logged in" → error
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.auth.status, "unauthenticated");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              if (joined === "login status")
                return { stdout: "Not logged in\n", stderr: "", code: 1 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );
    });
  },
);
