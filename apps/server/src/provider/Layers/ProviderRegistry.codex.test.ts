import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

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
    describe("checkCodexProviderStatus", () => {
      it.effect("returns ready when codex is installed and authenticated", () =>
        Effect.gen(function* () {
          // Point CODEX_HOME at an empty tmp dir (no config.toml) so the
          // default code path (OpenAI provider, auth probe runs) is exercised.
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus();
          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "authenticated");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns the codex plan type in auth and keeps spark for supported plans", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus(() =>
            Effect.succeed({
              type: "chatgpt" as const,
              planType: "pro" as const,
              sparkEnabled: true,
            }),
          );

          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "pro");
          assert.strictEqual(status.auth.label, "ChatGPT Pro 20x Subscription");
          assert.deepStrictEqual(
            status.models.some((model) => model.slug === "gpt-5.3-codex-spark"),
            true,
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("includes probed codex skills in the provider snapshot", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus(
            () =>
              Effect.succeed({
                type: "chatgpt" as const,
                planType: "pro" as const,
                sparkEnabled: true,
              }),
            () =>
              Effect.succeed([
                {
                  name: "github:gh-fix-ci",
                  path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
                  enabled: true,
                  displayName: "CI Debug",
                  shortDescription: "Debug failing GitHub Actions checks",
                },
              ]),
          );

          assert.deepStrictEqual(status.skills, [
            {
              name: "github:gh-fix-ci",
              path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
              enabled: true,
              displayName: "CI Debug",
              shortDescription: "Debug failing GitHub Actions checks",
            },
          ]);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("hides spark from codex models for unsupported chatgpt plans", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus(() =>
            Effect.succeed({
              type: "chatgpt" as const,
              planType: "plus" as const,
              sparkEnabled: false,
            }),
          );

          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "plus");
          assert.strictEqual(status.auth.label, "ChatGPT Plus Subscription");
          assert.deepStrictEqual(
            status.models.some((model) => model.slug === "gpt-5.3-codex-spark"),
            false,
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("hides spark from codex models for non-pro chatgpt subscriptions", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus(() =>
            Effect.succeed({
              type: "chatgpt" as const,
              planType: "team" as const,
              sparkEnabled: false,
            }),
          );

          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.auth.type, "team");
          assert.strictEqual(status.auth.label, "ChatGPT Team Subscription");
          assert.deepStrictEqual(
            status.models.some((model) => model.slug === "gpt-5.3-codex-spark"),
            false,
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns an api key label for codex api key auth", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus(() =>
            Effect.succeed({
              type: "apiKey" as const,
              planType: null,
              sparkEnabled: false,
            }),
          );

          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "apiKey");
          assert.strictEqual(status.auth.label, "OpenAI API Key");
          assert.deepStrictEqual(
            status.models.some((model) => model.slug === "gpt-5.3-codex-spark"),
            false,
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect.skipIf(process.platform === "win32")(
        "inherits PATH when launching the codex probe with a CODEX_HOME override",
        () =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const binDir = yield* fileSystem.makeTempDirectoryScoped({
              prefix: "t3-test-codex-bin-",
            });
            const codexPath = path.join(binDir, "codex");
            yield* fileSystem.writeFileString(
              codexPath,
              [
                "#!/bin/sh",
                'if [ "$1" = "--version" ]; then',
                '  echo "codex-cli 1.0.0"',
                "  exit 0",
                "fi",
                'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
                '  echo "Logged in using ChatGPT"',
                "  exit 0",
                "fi",
                'echo "unexpected args: $*" >&2',
                "exit 1",
                "",
              ].join("\n"),
            );
            yield* fileSystem.chmod(codexPath, 0o755);
            const customCodexHome = yield* fileSystem.makeTempDirectoryScoped({
              prefix: "t3-test-codex-home-",
            });
            const previousPath = process.env.PATH;
            process.env.PATH = binDir;

            try {
              const serverSettingsLayer = ServerSettingsService.layerTest({
                providers: {
                  codex: {
                    homePath: customCodexHome,
                  },
                },
              });

              const status = yield* checkCodexProviderStatus().pipe(
                Effect.provide(serverSettingsLayer),
              );
              assert.strictEqual(status.provider, "codex");
              assert.strictEqual(status.installed, true);
              assert.strictEqual(status.status, "ready");
              assert.strictEqual(status.auth.status, "authenticated");
            } finally {
              process.env.PATH = previousPath;
            }
          }),
      );

      it.effect("returns unavailable when codex is missing", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus();
          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Codex CLI (`codex`) is not installed or not on PATH.",
          );
        }).pipe(Effect.provide(failingSpawnerLayer("spawn codex ENOENT"))),
      );

      it.effect("returns unavailable when codex is below the minimum supported version", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus();
          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Codex CLI v0.99.0 is too old for bigbud. Upgrade to v0.100.0 or newer and restart bigbud.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "codex 0.99.0\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns unauthenticated when auth probe reports login required", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus();
          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "unauthenticated");
          assert.strictEqual(
            status.message,
            "Codex CLI is not authenticated. Run `codex login` and try again.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              if (joined === "login status") {
                return { stdout: "", stderr: "Not logged in. Run codex login.", code: 1 };
              }
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns unauthenticated when login status output includes 'not logged in'", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus();
          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "unauthenticated");
          assert.strictEqual(
            status.message,
            "Codex CLI is not authenticated. Run `codex login` and try again.",
          );
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

      it.effect("returns warning when login status command is unsupported", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus();
          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.status, "warning");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Codex CLI authentication status command is unavailable in this Codex version.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              if (joined === "login status") {
                return { stdout: "", stderr: "error: unknown command 'login'", code: 2 };
              }
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );
    });
  },
);
