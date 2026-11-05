import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { CliProxyLifecycle } from "../../Services/CliProxy/Lifecycle.ts";
import { checkCliProxyProvider } from "./Provider.ts";
import type { CliProxyInstallation } from "./Version.ts";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

async function check(input: {
  readonly runtime?: string;
  readonly inspectInstallation?: () => Promise<CliProxyInstallation>;
  readonly catalogStatus?: number;
}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-cliproxy-provider-version-"));
  directories.push(directory);
  const configPath = path.join(directory, "config.yaml");
  fs.writeFileSync(configPath, "host: 127.0.0.1\napi-keys:\n  - token\n");
  const fetch = vi.fn(async (url: URL) =>
    url.pathname === "/"
      ? new Response("CLI Proxy API Server", {
          headers: input.runtime ? { "X-CPA-VERSION": input.runtime } : {},
        })
      : new Response(JSON.stringify({ data: [{ id: "live-model" }] }), {
          status: input.catalogStatus ?? 200,
        }),
  );
  vi.stubGlobal("fetch", fetch);
  const activate = vi.fn();
  const snapshot = await Effect.runPromise(
    checkCliProxyProvider({
      inspectInstallation:
        input.inspectInstallation ??
        (async () => ({ version: "8.0.30", installation: "homebrew" })),
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettingsService.layerTest({ providers: { cliProxy: { configPath } } }),
          Layer.succeed(CliProxyLifecycle, {
            isClaudeRunnable: async () => ({ _tag: "available" }) as const,
            activate,
          }),
        ),
      ),
    ),
  );
  expect(activate).not.toHaveBeenCalled();
  expect(fetch.mock.calls.map(([url]) => url.pathname + url.search)).toEqual([
    "/",
    "/v1/models?client_version=0.1.0",
  ]);
  return snapshot;
}

describe("CLIProxyAPI advisory snapshots", () => {
  it.each([
    [undefined, "installed"],
    ["8.0.30", "runtime"],
    ["8.0.51", undefined],
    ["8.0.100", undefined],
  ] as const)(
    "keeps runtime %s usable without starting or updating anything",
    async (runtime, source) => {
      const snapshot = await check(runtime ? { runtime } : {});
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.version).toBe(runtime ?? null);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["live-model"]);
      expect(snapshot.failure).toBeUndefined();
      expect(snapshot.cliProxyDiagnostic).toBeUndefined();
      expect(snapshot.cliProxyVersion?.updateSource).toBe(source);
      expect(snapshot.cliProxyVersion?.installedVersion).toBe("8.0.30");
      expect(snapshot.runtimeUpdateRecommended).toBeUndefined();
    },
  );

  it("keeps a healthy service usable when local binary detection fails", async () => {
    const snapshot = await check({
      inspectInstallation: async () => {
        throw new Error("missing or denied");
      },
    });
    expect(snapshot.status).toBe("ready");
    expect(snapshot.cliProxyVersion).toMatchObject({
      installedVersion: null,
      runtimeVersion: null,
    });
    expect(snapshot.cliProxyVersion?.updateSource).toBeUndefined();
  });

  it("preserves authentication failures and does not attempt binary detection for them", async () => {
    const inspectInstallation = vi.fn();
    const snapshot = await check({ catalogStatus: 401, inspectInstallation });
    expect(snapshot.status).toBe("warning");
    expect(snapshot.cliProxyDiagnostic?.code).toBe("authentication-failed");
    expect(snapshot.cliProxyVersion).toBeUndefined();
    expect(inspectInstallation).not.toHaveBeenCalled();
  });
});
