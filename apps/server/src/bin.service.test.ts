import * as Effect from "effect/Effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  events: [] as string[],
  program: undefined as unknown,
  fail: false,
  importFails: false,
}));
function setupMocks() {
  vi.doMock("@effect/platform-node/NodeRuntime", () => ({
    runMain: (program: unknown) => {
      state.program = program;
    },
  }));
  vi.doMock("./serverLifecycleDiagnostics.ts", () => ({
    registerServerLifecycleDiagnostics: () => {},
  }));
  vi.doMock("./remote-backend/localSupervisorService.startup.ts", async () => {
    const Effect = await import("effect/Effect");
    state.events.push("preflight-import");
    if (state.importFails) throw new Error("fixture import refusal");
    return {
      preflightLocalSupervisorService: (path: string) =>
        Effect.gen(function* () {
          expect(path).toBe("/private/config-v1");
          expect(process.env.BIGBUD_REMOTE_SERVICE_CONFIG).toBeUndefined();
          state.events.push("preflight");
          if (state.fail) return yield* Effect.fail(new Error("refused"));
          state.events.push("preflight-closed");
          return { fixture: "resolved-config" };
        }),
    };
  });
  vi.doMock("./server.ts", async () => {
    const Effect = await import("effect/Effect");
    const { ServerConfig } = await import("./startup/config.ts");
    state.events.push("server-import");
    for (const key of credentialKeys) expect(process.env[key]).toBeUndefined();
    return {
      runServer: Effect.gen(function* () {
        const config = yield* ServerConfig;
        expect(config).toEqual({ fixture: "resolved-config" });
        state.events.push("server-run");
      }),
    };
  });
  vi.doMock("./cli/cli", () => {
    state.events.push("cli-import");
    expect(process.env.BIGBUD_REMOTE_SERVICE_CONFIG).toBeUndefined();
    return { cli: {} };
  });
  vi.doMock("effect/unstable/cli", async () => {
    const Effect = await import("effect/Effect");
    return {
      Command: {
        run: () =>
          Effect.sync(() => {
            state.events.push("cli-run");
          }),
      },
    };
  });
}
const originalEnv = { ...process.env };
const originalArgv = [...process.argv];
const credentialKeys = [
  "BIGBUD_AUTH_TOKEN",
  "T3CODE_AUTH_TOKEN",
  "BIGBUD_MOBILE_GATEWAY_UPSTREAM_CREDENTIAL",
];
beforeEach(() => {
  vi.resetModules();
  setupMocks();
  state.events = [];
  state.fail = false;
  state.importFails = false;
  state.program = undefined;
  delete process.env.BIGBUD_REMOTE_SERVICE_CONFIG;
  delete process.env.BIGBUD_REMOTE_SERVICE_PREFLIGHT_ONLY;
});
afterEach(() => {
  process.env = { ...originalEnv };
  process.argv = [...originalArgv];
  vi.restoreAllMocks();
});
async function runEntry() {
  await import("./bin.ts");
  return Effect.runPromiseExit(state.program as Effect.Effect<unknown>);
}
it("finishes preflight and removes credentials before loading the configured server", async () => {
  process.env.BIGBUD_REMOTE_SERVICE_CONFIG = "/private/config-v1";
  for (const key of credentialKeys) process.env[key] = "private-test-value";
  expect((await runEntry())._tag).toBe("Success");
  expect(state.events).toEqual([
    "preflight-import",
    "preflight",
    "preflight-closed",
    "server-import",
    "server-run",
  ]);
});
it("refuses startup without loading the CLI after failed preflight", async () => {
  process.env.BIGBUD_REMOTE_SERVICE_CONFIG = "/private/config-v1";
  state.fail = true;
  for (const key of credentialKeys) process.env[key] = "private-test-value";
  expect((await runEntry())._tag).toBe("Failure");
  expect(state.events).toEqual(["preflight-import", "preflight"]);
  for (const key of credentialKeys) expect(process.env[key]).toBeUndefined();
});
it("keeps ordinary startup independent of account service preflight", async () => {
  expect((await runEntry())._tag).toBe("Success");
  expect(state.events).toEqual(["cli-import", "cli-run"]);
});

it("removes service credentials even when the startup module cannot load", async () => {
  process.env.BIGBUD_REMOTE_SERVICE_CONFIG = "/private/config-v1";
  state.importFails = true;
  for (const key of credentialKeys) process.env[key] = "private-test-value";
  expect((await runEntry())._tag).toBe("Failure");
  expect(state.events).toEqual(["preflight-import"]);
  for (const key of credentialKeys) expect(process.env[key]).toBeUndefined();
});

it("runs the same finite preflight without importing or starting the server", async () => {
  process.env.BIGBUD_REMOTE_SERVICE_CONFIG = "/private/config-v1";
  process.env.BIGBUD_REMOTE_SERVICE_PREFLIGHT_ONLY = "1";
  for (const key of credentialKeys) process.env[key] = "private-test-value";
  expect((await runEntry())._tag).toBe("Success");
  expect(state.events).toEqual(["preflight-import", "preflight", "preflight-closed"]);
  expect(process.env.BIGBUD_REMOTE_SERVICE_PREFLIGHT_ONLY).toBeUndefined();
  for (const key of credentialKeys) expect(process.env[key]).toBeUndefined();
});

it.each(["0", "", "true"])(
  "refuses invalid finite-only marker %j before importing startup",
  async (marker) => {
    process.env.BIGBUD_REMOTE_SERVICE_CONFIG = "/private/config-v1";
    process.env.BIGBUD_REMOTE_SERVICE_PREFLIGHT_ONLY = marker;
    for (const key of credentialKeys) process.env[key] = "private-test-value";
    expect((await runEntry())._tag).toBe("Failure");
    expect(state.events).toEqual([]);
    expect(process.env.BIGBUD_REMOTE_SERVICE_PREFLIGHT_ONLY).toBeUndefined();
    for (const key of credentialKeys) expect(process.env[key]).toBeUndefined();
  },
);

it("refuses finite-only startup without private configuration", async () => {
  process.env.BIGBUD_REMOTE_SERVICE_PREFLIGHT_ONLY = "1";
  expect((await runEntry())._tag).toBe("Failure");
  expect(state.events).toEqual([]);
});

it("reports a fixed capability without importing CLI, preflight or server", async () => {
  process.argv = [process.execPath, "/private/bin.mjs", "--remote-service-capabilities"];
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect((await runEntry())._tag).toBe("Success");
  expect(state.events).toEqual([]);
  expect(write).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({
    schemaVersion: 1,
    backendVersion: expect.any(String),
    accountServicePreflight: 1,
  });
});

it("refuses capability probing with extra overrides", async () => {
  process.argv = [
    process.execPath,
    "/private/bin.mjs",
    "--remote-service-capabilities",
    "--port",
    "1",
  ];
  expect((await runEntry())._tag).toBe("Failure");
  expect(state.events).toEqual([]);
});
