import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { NetService } from "@bigbud/shared/Net";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  events: [] as string[],
  token: "a".repeat(64),
  authority: "b".repeat(32),
  fingerprint: `sha256:${"c".repeat(64)}`,
  identityMismatch: false,
  reconcileFails: false,
}));
vi.mock("./localSupervisorService.config.read.ts", () => ({
  readLocalSupervisorServiceConfig: async () => {
    fixture.events.push("config");
    return {
      config: {
        home: "/fixture",
        backend_home: "/fixture/backend",
        authority: fixture.authority,
        expected_installation_fingerprint: fixture.fingerprint,
      },
    };
  },
}));
vi.mock("./localSupervisorService.files.ts", () => ({
  readLocalSupervisorServiceFile: async () => fixture.token,
}));
vi.mock("../cli/cli.config.ts", () => ({
  resolveServerConfig: () => Effect.succeed({ fixture: true, mode: "remote" }),
}));
vi.mock("./localSupervisorService.preflight.ts", () => ({
  runLocalSupervisorServicePreflight: (input: {
    requireExistingIdentity: boolean;
    validateIdentity: (identity: unknown) => void;
    operation: (context: unknown, signal: AbortSignal) => Promise<void>;
  }) =>
    Effect.tryPromise(async () => {
      expect(input.requireExistingIdentity).toBe(true);
      const identity = {
        authority: { authorityId: fixture.identityMismatch ? "wrong" : fixture.authority },
        installationFingerprint: fixture.fingerprint,
      };
      input.validateIdentity(identity);
      return input.operation({ identity, owners: {} }, new AbortController().signal);
    }),
}));
vi.mock("./localSupervisorControl.ts", () => ({ makeLocalSupervisorControl: () => ({}) }));
vi.mock("./localSupervisorService.boot.ts", () => ({
  makeLocalSupervisorBootReconciler: () => ({
    reconcile: async (signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      fixture.events.push("reconcile");
      if (fixture.reconcileFails) throw new Error("fixture refusal");
    },
    close: () => fixture.events.push("close"),
  }),
}));
import { preflightLocalSupervisorService } from "./localSupervisorService.startup.ts";
const originalEnv = { ...process.env };
const originalArgv = process.argv;
beforeEach(() => {
  fixture.events = [];
  fixture.identityMismatch = false;
  fixture.reconcileFails = false;
  process.argv = ["node", "/fixture/bin.mjs"];
  process.env.BIGBUD_MODE = "remote";
  process.env.BIGBUD_HOME = "/fixture/backend";
  process.env.BIGBUD_AUTH_TOKEN = fixture.token;
  process.env.BIGBUD_NO_BROWSER = "true";
  process.env.BIGBUD_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = "false";
});
afterEach(() => {
  process.env = { ...originalEnv };
  process.argv = originalArgv;
});
const run = () =>
  Effect.runPromiseExit(
    preflightLocalSupervisorService("/fixture/config-v1").pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
    ),
  );
it("closes the finite reconciler before returning", async () => {
  expect((await run())._tag).toBe("Success");
  expect(fixture.events).toEqual(["config", "reconcile", "close"]);
});
it("closes the reconciler when canonical reconciliation refuses", async () => {
  fixture.reconcileFails = true;
  expect((await run())._tag).toBe("Failure");
  expect(fixture.events).toEqual(["config", "reconcile", "close"]);
});
it("refuses another installation before any runtime operation", async () => {
  fixture.identityMismatch = true;
  expect((await run())._tag).toBe("Failure");
  expect(fixture.events).toEqual(["config"]);
});
it.each([
  "BIGBUD_AUTH_TOKEN",
  "BIGBUD_HOME",
  "BIGBUD_NO_BROWSER",
  "BIGBUD_AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
])("refuses mismatched %s without runtime work", async (key) => {
  process.env[key] = "mismatch";
  expect((await run())._tag).toBe("Failure");
  expect(fixture.events).toEqual(["config"]);
});
it.each(["mode", "arguments"])("refuses invalid %s before private file access", async (kind) => {
  if (kind === "mode") process.env.BIGBUD_MODE = "web";
  else process.argv.push("--home", "/other");
  expect((await run())._tag).toBe("Failure");
  expect(fixture.events).toEqual([]);
});
