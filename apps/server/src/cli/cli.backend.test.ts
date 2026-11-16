import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Command from "effect/unstable/cli/Command";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NetService } from "@bigbud/shared/Net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { backendCommand } from "./cli.backend.ts";
import { runBackendSetupCli, runBackendNativeCli } from "./cli.backend.operations.ts";
import { BackendCliError } from "./cli.backend.effect.ts";
vi.mock("./cli.backend.operations.ts", () => ({
  runBackendSetupCli: vi.fn(),
  runBackendNativeCli: vi.fn(),
}));
const previousExit = process.exitCode;
beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.mocked(runBackendSetupCli).mockReturnValue(
    Effect.fail(new BackendCliError({ message: "PRIVATE" })),
  );
  vi.mocked(runBackendNativeCli).mockReturnValue(
    Effect.fail(new BackendCliError({ message: "PRIVATE" })),
  );
});
afterEach(() => {
  process.exitCode = previousExit;
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
const run = (args: string[]) =>
  Effect.runPromise(
    Effect.scoped(Command.runWith(backendCommand, { version: "fixture" })(args)).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
    ),
  );
const setup = [
  "setup",
  "--graph-root",
  "/graph",
  "--graph-manifest",
  "/graph.json",
  "--rust-manifest",
  "/rust.json",
  "--trusted-keys",
  "/keys.json",
  "--backend-home",
  "/backend",
  "--request-id",
  "11111111-1111-4111-8111-111111111111",
];
it("requires explicit fresh-setup confirmation before invoking account operations", async () => {
  await run(setup);
  expect(runBackendSetupCli).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});
it("passes complete signed-input selectors and keeps failures private", async () => {
  await run([...setup, "--confirm-fresh-setup"]);
  expect(runBackendSetupCli).toHaveBeenCalledWith({
    graphRoot: "/graph",
    graphManifest: "/graph.json",
    rustManifest: "/rust.json",
    trustedKeys: "/keys.json",
    backendHome: "/backend",
    requestId: "11111111-1111-4111-8111-111111111111",
    confirmFreshSetup: true,
    restart: "on-failure",
  });
  expect(vi.mocked(process.stdout.write)).not.toHaveBeenCalled();
  expect(vi.mocked(process.stderr.write).mock.calls.flat().join("")).not.toContain("PRIVATE");
  expect(process.exitCode).toBe(1);
});
it("never enables startup without explicit confirmation", async () => {
  await run(["enable", "--authority", "a".repeat(32)]);
  expect(runBackendNativeCli).not.toHaveBeenCalled();
  await run(["enable", "--authority", "a".repeat(32), "--confirm-startup"]);
  expect(runBackendNativeCli).toHaveBeenCalledWith({
    authorityId: "a".repeat(32),
    action: "enable",
    confirmStartup: true,
  });
});
it("reports observed unit status without claiming backend readiness", async () => {
  vi.mocked(runBackendNativeCli).mockReturnValue(
    Effect.succeed({ authorityId: "a".repeat(32), action: "status", output: '{"active":false}' }),
  );
  await run(["status", "--authority", "a".repeat(32)]);
  const text = vi.mocked(process.stdout.write).mock.calls.flat().join("");
  expect(text).toContain('"active":false');
  expect(text).toContain("readiness is not assessed");
});
