import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { CliProxyLifecycle } from "../../Services/CliProxy/Lifecycle.ts";
import { checkCliProxyProvider } from "./Provider.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("checkCliProxyProvider", () => {
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
              isClaudeRunnable: async () =>
                ({
                  _tag: "missing",
                  command: "claude",
                }) as const,
              activate: async () =>
                ({ _tag: "unavailable", strategy: "none", detail: "unused" }) as const,
            }),
          ),
        ),
      ),
    );

    expect(status.status).toBe("warning");
    expect(status.message).toContain("requires a runnable configured Claude CLI");
  });
});
