import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestSettings } from "../../ws/serverSettings.testing.ts";
import { makeMetadataExecutionIdentity } from "./ThreadMetadataGeneration.executionIdentity.ts";
import { evidenceFixture } from "./ThreadMetadataGeneration.identity.test-helpers.ts";

const config = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../../provider/Layers/CliProxy/config.ts", () => ({
  resolveCliProxyConfig: config.resolve,
}));
const selection = {
  provider: "cliProxy",
  model: "exact-gateway-model",
  options: { effort: "high" },
} as const;

function fixture(enabled = true) {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      cliProxy: {
        ...DEFAULT_SERVER_SETTINGS.providers.cliProxy,
        enabled,
        configPath: "/synthetic/config.yaml",
      },
    },
  };
  const read = vi.fn(() => Effect.die("Unexpected user credential read"));
  const spawn = vi.fn(() => Effect.die("Unexpected subprocess"));
  const api = () =>
    Effect.runPromise(
      makeTestSettings(settings).pipe(
        Effect.flatMap(makeMetadataExecutionIdentity),
        Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({ readFileString: read })),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(spawn),
        ),
      ),
    );
  return { api, settings, read, spawn, context: evidenceFixture().context };
}

beforeEach(() => {
  config.resolve.mockReset().mockImplementation(() => ({
    baseUrl: new URL("http://127.0.0.1:9999"),
    apiKey: "synthetic-secret",
    configPath: "/synthetic/config.yaml",
  }));
});

describe("CLIProxy durable execution identity", () => {
  it("captures no-override gateway scope and rejects credential rotation before dispatch", async () => {
    const f = fixture();
    expect(f.settings.textGenerationModelSelection).toBeNull();
    const identity = await f.api();
    const path = (await Effect.runPromise(identity.capture(selection, "local")))!;
    expect(path).toMatchObject({ selection, mode: "auxiliary" });
    expect(JSON.stringify(path)).not.toMatch(/synthetic-secret|127\.0\.0\.1|config.yaml/);
    expect(await Effect.runPromise(identity.providerSettings(f.context, path))).toEqual(
      f.settings.providers,
    );
    config.resolve.mockReturnValue({
      baseUrl: new URL("http://127.0.0.1:9999"),
      apiKey: "rotated-secret",
      configPath: "/synthetic/config.yaml",
    });
    expect(await Effect.runPromise(identity.providerSettings(f.context, path))).toBeNull();
    const claimed = vi.fn();
    const result = await Effect.runPromise(
      identity
        .withExecutionIdentity(
          f.context,
          path,
          { revision: 1, settings: f.settings },
          Effect.sync(claimed),
        )
        .pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    expect(claimed).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each(["remote", "disabled"])(
    "does not read configuration for %s authority",
    async (scenario) => {
      const f = fixture(scenario !== "disabled");
      const identity = await f.api();
      expect(
        await Effect.runPromise(
          identity.capture(selection, scenario === "remote" ? "ssh:fixture" : "local"),
        ),
      ).toBeNull();
      expect(config.resolve).not.toHaveBeenCalled();
    },
  );

  it("fails closed when config cannot be resolved", async () => {
    config.resolve.mockImplementation(() => {
      throw new Error("private diagnostic");
    });
    expect(await Effect.runPromise((await fixture().api()).capture(selection, "local"))).toBeNull();
  });
});
