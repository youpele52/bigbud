import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { CliProxyLifecycle } from "../../Services/CliProxy/Lifecycle.ts";
import { checkCliProxyProvider } from "./Provider.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("checkCliProxyProvider", () => {
  it("publishes discovered efforts without inventing support or listing hidden images", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-cliproxy-effort-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "config.yaml");
    fs.writeFileSync(configPath, "host: 127.0.0.1\napi-keys:\n  - token\n");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("CLI Proxy API Server"))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              models: [
                {
                  slug: "live-model",
                  supported_reasoning_levels: [{ effort: "high" }],
                  default_reasoning_level: "high",
                },
                { slug: "unknown-model" },
                {
                  slug: "image-model",
                  visibility: "hide",
                  supported_reasoning_levels: [{ effort: "high" }],
                },
              ],
            }),
          ),
        ),
    );
    const snapshot = await Effect.runPromise(
      checkCliProxyProvider({
        inspectInstallation: async () => ({ version: null, installation: "unknown" }),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSettingsService.layerTest({ providers: { cliProxy: { configPath } } }),
            Layer.succeed(CliProxyLifecycle, {
              isClaudeRunnable: async () => ({ _tag: "available" }) as const,
              activate: async () => ({ _tag: "started", reused: false }) as const,
            }),
          ),
        ),
      ),
    );
    expect(snapshot.models.map((model) => model.slug)).toEqual(["live-model", "unknown-model"]);
    expect(snapshot.models[0]?.capabilities?.reasoningEffortLevels).toEqual([
      { value: "high", label: "High", isDefault: true },
    ]);
    expect(snapshot.models[1]?.capabilities?.reasoningEffortLevels).toEqual([]);
  });

  it("requires the configured Claude CLI before probing the proxy catalog", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-cliproxy-provider-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "config.yaml");
    fs.writeFileSync(configPath, "host: 127.0.0.1\napi-keys:\n  - token\n");

    const status = await Effect.runPromise(
      checkCliProxyProvider().pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSettingsService.layerTest({ providers: { cliProxy: { configPath } } }),
            Layer.succeed(CliProxyLifecycle, {
              isClaudeRunnable: async () => ({ _tag: "missing" }) as const,
              activate: async () => ({ _tag: "unavailable" }) as const,
            }),
          ),
        ),
      ),
    );

    expect(status.status).toBe("warning");
    expect(status.message).toBeUndefined();
    expect(status.cliProxyDiagnostic).toEqual({
      code: "claude-cli-unavailable",
      classification: "user-action-required",
      action: "install-or-configure-claude",
    });
  });
});
