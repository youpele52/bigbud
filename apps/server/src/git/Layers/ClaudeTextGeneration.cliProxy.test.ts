import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, Path } from "effect";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";
import { ClaudeTextGenerationLive } from "./ClaudeTextGeneration.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { decodeCliProxyCapabilities } from "../../provider/Layers/CliProxy/Capabilities.ts";

const runtime = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../../provider/Layers/CliProxy/RuntimeConfig.ts", () => ({
  resolveCliProxyRuntimeConfig: (...args: unknown[]) => runtime.resolve(...args),
}));

const TestLayer = ClaudeTextGenerationLive.pipe(
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(NodeServices.layer),
);
const selection = {
  provider: "cliProxy",
  model: "custom-proxy-wire-model",
  options: { effort: "high" },
} as const;

function withFakeHarness<A, E, R>(
  exitCode: number,
  use: (capture: string) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "bigbud-proxy-title-" });
    const binaryPath = path.join(dir, "fake-claude");
    const capture = path.join(dir, "capture.json");
    yield* fs.writeFileString(
      binaryPath,
      [
        `#!${process.execPath}`,
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const arg = key => args[args.indexOf(key) + 1];",
        "const settingsPath = arg('--settings');",
        "const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));",
        "fs.writeFileSync(process.env.PROBE_CAPTURE, JSON.stringify({args, settingsPath, settings, permissions: fs.statSync(settingsPath).mode & 0o777, auth: process.env.ANTHROPIC_AUTH_TOKEN, endpoint: process.env.ANTHROPIC_BASE_URL}));",
        `if (${exitCode} === -1) { setInterval(() => {}, 1000); } else if (${exitCode}) { process.stderr.write('fixture-secret-token'); process.exit(${exitCode}); }`,
        "process.stdout.write(JSON.stringify({structured_output:{title:'Investigate proxy title generation'}}));",
      ].join("\n"),
    );
    yield* fs.chmod(binaryPath, 0o755);
    runtime.resolve.mockReset();
    runtime.resolve.mockImplementation(() =>
      Effect.succeed({
        harness: {
          binaryPath,
          modelCapabilities: decodeCliProxyCapabilities([{ effort: "high" }], "high"),
          settingSources: ["user", "project", "local"],
          protectedSettingsEnvironment: {
            ANTHROPIC_AUTH_TOKEN: "fixture-secret-token",
            ANTHROPIC_BASE_URL: "http://127.0.0.1:9999/never-contacted",
            ANTHROPIC_MODEL: selection.model,
          },
          environment: {
            PROBE_CAPTURE: capture,
            ANTHROPIC_AUTH_TOKEN: "fixture-secret-token",
            ANTHROPIC_BASE_URL: "http://127.0.0.1:9999/never-contacted",
          },
        },
      }),
    );
    return yield* use(capture);
  });
}

it.layer(TestLayer)("CLIProxy titles reuse structured Claude generation", (it) => {
  it.effect("uses the resolved exact-model harness and protects settings without a chat turn", () =>
    withFakeHarness(0, (capture) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const generation = yield* TextGeneration;
        const result = yield* generation.generateThreadTitle({
          cwd: process.cwd(),
          message: "Investigate proxy titles",
          modelSelection: selection,
        });
        expect(result.title).toBe("Investigate proxy title generation");
        expect(runtime.resolve).toHaveBeenCalledTimes(1);
        expect(runtime.resolve.mock.calls[0]?.[0]).toMatchObject({
          provider: "cliProxy",
          modelSelection: selection,
          cwd: process.cwd(),
        });
        const recorded = JSON.parse(yield* fs.readFileString(capture));
        expect(recorded.args).toContain(selection.model);
        expect(recorded.args).toContain("high");
        expect(recorded.args).toContain("user,project,local");
        expect(JSON.stringify(recorded.args)).not.toContain("fixture-secret-token");
        expect(recorded.settings.env.ANTHROPIC_AUTH_TOKEN).toBe("fixture-secret-token");
        expect(recorded.settings.apiKeyHelper).toBe("");
        expect(recorded.permissions).toBe(0o600);
        expect(recorded.auth).toBe("fixture-secret-token");
        expect(recorded.endpoint).toBe("http://127.0.0.1:9999/never-contacted");
        expect(yield* fs.exists(recorded.settingsPath)).toBe(false);
      }),
    ),
  );

  it.effect("cleans protected settings and does not expose credential-bearing child failures", () =>
    withFakeHarness(7, (capture) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const generation = yield* TextGeneration;
        const error = yield* generation
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "Investigate proxy titles",
            modelSelection: selection,
          })
          .pipe(Effect.flip);
        expect(error.detail).toContain("code 7");
        expect(JSON.stringify(error)).not.toContain("fixture-secret-token");
        const recorded = JSON.parse(yield* fs.readFileString(capture));
        expect(yield* fs.exists(recorded.settingsPath)).toBe(false);
      }),
    ),
  );

  it.effect("cleans protected settings when generation is interrupted", () =>
    withFakeHarness(-1, (capture) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const generation = yield* TextGeneration;
        const fiber = yield* generation
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "Investigate proxy titles",
            modelSelection: selection,
          })
          .pipe(Effect.forkChild);
        yield* Effect.gen(function* () {
          while (!(yield* fs.exists(capture))) yield* Effect.sleep("10 millis");
        }).pipe(Effect.timeout("5 seconds"), TestClock.withLive);
        const recorded = JSON.parse(yield* fs.readFileString(capture));
        expect(yield* fs.exists(recorded.settingsPath)).toBe(true);
        yield* Fiber.interrupt(fiber);
        expect(yield* fs.exists(recorded.settingsPath)).toBe(false);
      }),
    ),
  );

  it.effect("fails closed if the configured proxy harness cannot be resolved", () =>
    Effect.gen(function* () {
      runtime.resolve.mockReset();
      runtime.resolve.mockReturnValue(Effect.fail(new Error("fixture-secret-token")));
      const generation = yield* TextGeneration;
      const error = yield* generation
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "Investigate proxy titles",
          modelSelection: selection,
        })
        .pipe(Effect.flip);
      expect(error.detail).toBe("CLIProxy Claude harness is unavailable for the selected model.");
      expect(JSON.stringify(error)).not.toContain("fixture-secret-token");
    }),
  );
});
