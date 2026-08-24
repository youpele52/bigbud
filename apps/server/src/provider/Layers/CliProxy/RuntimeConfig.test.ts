import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";

import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { CliProxyLifecycle } from "../../Services/CliProxy/Lifecycle.ts";
import { CliProxyClientError } from "./Client.ts";
import { activateCliProxyRuntime, makeResolveCliProxyRuntimeConfig } from "./RuntimeConfig.ts";

const tempDirectories: string[] = [];

function configFile(apiKey: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-cliproxy-runtime-"));
  tempDirectories.push(directory);
  const configPath = path.join(directory, "config.yaml");
  fs.writeFileSync(
    configPath,
    `host: 127.0.0.1\nport: 8317\napi-keys:\n  - "${apiKey}"\ntls:\n  enable: false\n`,
  );
  return configPath;
}

function input(model = "gpt-5-codex") {
  return {
    threadId: "thread-cli-proxy-runtime",
    provider: "cliProxy",
    modelSelection: { provider: "cliProxy", model },
    runtimeMode: "full-access",
  } as never;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("activateCliProxyRuntime", () => {
  it("coalesces activation at the caller while reusing health inspection and retry behavior", async () => {
    const configPath = configFile("token");
    const inspect = vi
      .fn()
      .mockRejectedValueOnce(new CliProxyClientError("HealthProbeFailed", "not running"))
      .mockResolvedValue([{ id: "gpt-5-codex", name: "GPT-5 Codex" }]);
    const activate = vi.fn(async () => ({ _tag: "started", strategy: "direct" }) as const);
    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* ServerSettingsService;
      }).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({ providers: { cliProxy: { configPath } } }),
        ),
      ),
    ).then((service) => Effect.runPromise(service.getSettings));

    await activateCliProxyRuntime(
      {
        settings,
        lifecycle: {
          isClaudeRunnable: async () => ({ _tag: "available" }) as const,
          activate,
        },
      },
      { inspect, sleep: async () => undefined },
    );

    expect(activate).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("does not start a process when CLIProxyAPI is already healthy", async () => {
    const configPath = configFile("token");
    const activate = vi.fn();
    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        return yield* service.getSettings;
      }).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({ providers: { cliProxy: { configPath } } }),
        ),
      ),
    );

    await activateCliProxyRuntime(
      {
        settings,
        lifecycle: {
          isClaudeRunnable: async () => ({ _tag: "available" }) as const,
          activate,
        },
      },
      { inspect: async () => [{ id: "gpt-5-codex", name: "GPT-5 Codex" }] },
    );

    expect(activate).not.toHaveBeenCalled();
  });
});

describe("resolveCliProxyRuntimeConfig", () => {
  it("reads fresh settings for each session and returns an isolated frozen harness", async () => {
    const firstPath = configFile("first-token");
    const secondPath = configFile("second-token");
    const originalElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
    const originalNodeExecutable = process.env.BIGBUD_NODE_EXECUTABLE;
    const originalUnrelatedSecret = process.env.BIGBUD_RUNTIME_CONFIG_TEST_SECRET;
    const inspect = vi.fn(async () => [{ id: "gpt-5-codex", name: "GPT-5 Codex" }]);
    const activate = vi.fn(async () => ({ _tag: "started", strategy: "direct" }) as const);
    const settingsLayer = ServerSettingsService.layerTest({
      providers: { cliProxy: { configPath: firstPath } },
    });
    const lifecycleLayer = Layer.succeed(CliProxyLifecycle, {
      isClaudeRunnable: async () => ({ _tag: "available" }) as const,
      activate,
    });
    const resolveRuntime = makeResolveCliProxyRuntimeConfig({ inspect });

    process.env.ELECTRON_RUN_AS_NODE = "1";
    process.env.BIGBUD_NODE_EXECUTABLE = "/Applications/bigbud.app/Contents/MacOS/bigbud";
    process.env.BIGBUD_RUNTIME_CONFIG_TEST_SECRET = "must-not-leak";
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const first = yield* resolveRuntime(input());
        yield* settings.updateSettings({ providers: { cliProxy: { configPath: secondPath } } });
        delete process.env.ELECTRON_RUN_AS_NODE;
        const second = yield* resolveRuntime(input());
        return { first, second };
      }).pipe(Effect.provide(Layer.mergeAll(settingsLayer, lifecycleLayer))),
    ).finally(() => {
      if (originalElectronRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = originalElectronRunAsNode;
      if (originalNodeExecutable === undefined) delete process.env.BIGBUD_NODE_EXECUTABLE;
      else process.env.BIGBUD_NODE_EXECUTABLE = originalNodeExecutable;
      if (originalUnrelatedSecret === undefined)
        delete process.env.BIGBUD_RUNTIME_CONFIG_TEST_SECRET;
      else process.env.BIGBUD_RUNTIME_CONFIG_TEST_SECRET = originalUnrelatedSecret;
    });

    expect(result.first.harness.environment).toEqual({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ELECTRON_RUN_AS_NODE: "1",
      ANTHROPIC_AUTH_TOKEN: "first-token",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
    });
    expect(result.second.harness.environment).toEqual({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ANTHROPIC_AUTH_TOKEN: "second-token",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
    });
    expect(result.second.harness.settingSources).toEqual([]);
    expect(Object.isFrozen(result.second)).toBe(true);
    expect(Object.isFrozen(result.second.harness)).toBe(true);
    expect(activate).not.toHaveBeenCalled();
  });

  it("activates only after a health failure and retries with a bounded delay", async () => {
    const configPath = configFile("token");
    const inspect = vi
      .fn()
      .mockRejectedValueOnce(new CliProxyClientError("HealthProbeFailed", "not running"))
      .mockResolvedValueOnce([{ id: "gpt-5-codex", name: "GPT-5 Codex" }]);
    const activate = vi.fn(async () => ({ _tag: "started", strategy: "direct" }) as const);
    const sleep = vi.fn(async () => undefined);
    const layer = Layer.mergeAll(
      ServerSettingsService.layerTest({ providers: { cliProxy: { configPath } } }),
      Layer.succeed(CliProxyLifecycle, {
        isClaudeRunnable: async () => ({ _tag: "available" }) as const,
        activate,
      }),
    );

    const result = await Effect.runPromise(
      makeResolveCliProxyRuntimeConfig({ inspect, sleep })(input()).pipe(Effect.provide(layer)),
    );

    expect(result.selectedModel).toBe("gpt-5-codex");
    expect(activate).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects stale models before constructing the Claude-compatible query", async () => {
    const configPath = configFile("token");
    const layer = Layer.mergeAll(
      ServerSettingsService.layerTest({ providers: { cliProxy: { configPath } } }),
      Layer.succeed(CliProxyLifecycle, {
        isClaudeRunnable: async () => ({ _tag: "available" }) as const,
        activate: async () => ({ _tag: "started", strategy: "direct" }) as const,
      }),
    );

    const result = await Effect.runPromise(
      Effect.result(
        makeResolveCliProxyRuntimeConfig({
          inspect: async () => [{ id: "available", name: "Available" }],
        })(input("stale-model")),
      ).pipe(Effect.provide(layer)),
    );

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProviderAdapterValidationError", provider: "cliProxy" },
    });
    if (result._tag === "Failure" && result.failure._tag === "ProviderAdapterValidationError") {
      expect(result.failure.issue).toContain("Available models: available");
    }
  });

  it("requires the cliProxy model selection provider", async () => {
    const configPath = configFile("token");
    const layer = Layer.mergeAll(
      ServerSettingsService.layerTest({ providers: { cliProxy: { configPath } } }),
      Layer.succeed(CliProxyLifecycle, {
        isClaudeRunnable: async () => ({ _tag: "available" }) as const,
        activate: async () => ({ _tag: "started", strategy: "direct" }) as const,
      }),
    );

    const result = await Effect.runPromise(
      Effect.result(
        makeResolveCliProxyRuntimeConfig({
          inspect: async () => [{ id: "available", name: "Available" }],
        })({
          threadId: "thread-cli-proxy-runtime-wrong-provider",
          provider: "cliProxy",
          modelSelection: { provider: "claudeAgent", model: "available" },
          runtimeMode: "full-access",
        } as never),
      ).pipe(Effect.provide(layer)),
    );

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProviderAdapterValidationError", provider: "cliProxy" },
    });
  });
});
