import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { checkClaudeProviderStatus, parseClaudeAuthStatusFromOutput } from "./Claude/Provider";
import { ServerSettingsService } from "../../ws/serverSettings";

import { failingSpawnerLayer, mockSpawnerLayer } from "./ProviderRegistry.test.helpers";

// ── parseClaudeAuthStatusFromOutput pure tests ────────────────────────

describe("parseClaudeAuthStatusFromOutput", () => {
  it("exit code 0 with no auth markers is ready", () => {
    const parsed = parseClaudeAuthStatusFromOutput({ stdout: "OK\n", stderr: "", code: 0 });
    assert.strictEqual(parsed.status, "ready");
    assert.strictEqual(parsed.auth.status, "authenticated");
  });

  it("JSON with loggedIn=true is authenticated", () => {
    const parsed = parseClaudeAuthStatusFromOutput({
      stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
      stderr: "",
      code: 0,
    });
    assert.strictEqual(parsed.status, "ready");
    assert.strictEqual(parsed.auth.status, "authenticated");
  });

  it("JSON with loggedIn=false is unauthenticated", () => {
    const parsed = parseClaudeAuthStatusFromOutput({
      stdout: '{"loggedIn":false}\n',
      stderr: "",
      code: 0,
    });
    assert.strictEqual(parsed.status, "error");
    assert.strictEqual(parsed.auth.status, "unauthenticated");
  });

  it("JSON without auth marker is warning", () => {
    const parsed = parseClaudeAuthStatusFromOutput({
      stdout: '{"ok":true}\n',
      stderr: "",
      code: 0,
    });
    assert.strictEqual(parsed.status, "warning");
    assert.strictEqual(parsed.auth.status, "unknown");
  });
});

// ── checkClaudeProviderStatus effect tests ────────────────────────────

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsService.layerTest()))(
  "ProviderRegistry",
  (it) => {
    describe("checkClaudeProviderStatus", () => {
      it.effect("returns ready when claude is installed and authenticated", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus();
          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "authenticated");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns a display label for claude subscription types", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus();
          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "maxplan");
          assert.strictEqual(status.auth.label, "Claude Max Subscription");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout:
                    '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"maxplan"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("includes probed claude slash commands in the provider snapshot", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            () => Effect.succeed("maxplan"),
            () =>
              Effect.succeed([
                {
                  name: "review",
                  description: "Review a pull request",
                  input: { hint: "pr-or-branch" },
                },
              ]),
          );

          assert.deepStrictEqual(status.slashCommands, [
            {
              name: "review",
              description: "Review a pull request",
              input: { hint: "pr-or-branch" },
            },
          ]);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("deduplicates probed claude slash commands by name", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            () => Effect.succeed("maxplan"),
            () =>
              Effect.succeed([
                {
                  name: "ui",
                  description: "Explore and refine UI",
                },
                {
                  name: "ui",
                  input: { hint: "component-or-screen" },
                },
              ]),
          );

          assert.deepStrictEqual(status.slashCommands, [
            {
              name: "ui",
              description: "Explore and refine UI",
              input: { hint: "component-or-screen" },
            },
          ]);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns an api key label for claude api key auth", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus();
          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "apiKey");
          assert.strictEqual(status.auth.label, "Claude API Key");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"api-key"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns unavailable when claude is missing", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus();
          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Claude Agent CLI (`claude`) is not installed or not on PATH.",
          );
        }).pipe(Effect.provide(failingSpawnerLayer("spawn claude ENOENT"))),
      );

      it.effect("returns error when version check fails with non-zero exit code", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus();
          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, true);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version")
                return { stdout: "", stderr: "Something went wrong", code: 1 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns unauthenticated when auth status reports not logged in", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus();
          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "unauthenticated");
          assert.strictEqual(
            status.message,
            "Claude is not authenticated. Run `claude auth login` and try again.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":false}\n',
                  stderr: "",
                  code: 1,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns unauthenticated when output includes 'not logged in'", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus();
          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "unauthenticated");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return { stdout: "Not logged in\n", stderr: "", code: 1 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns warning when auth status command is unsupported", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus();
          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "warning");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Claude Agent authentication status command is unavailable in this version of Claude.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return { stdout: "", stderr: "error: unknown command 'auth'", code: 2 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );
    });
  },
);
