import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDevRunnerWithInput } from "./dev-runner.ts";
import type { DevMode } from "./dev-runner.lib.ts";

const reserveRunnerPorts = vi.hoisted(() => vi.fn());
vi.mock("./dev-runner.coordination.ts", () => ({ reserveRunnerPorts }));

const ownerArtifact = JSON.stringify({
  reason: "compiler-artifact",
  target: { name: "bigbud-ssh-owner", kind: ["bin"] },
  executable: process.execPath,
});

const isOwnerBuild = (command: ChildProcess.StandardCommand) =>
  command.command === "cargo" && command.args.includes("bigbud-ssh-owner");

function launch(mode: DevMode, options: { dryRun?: boolean; ownerExitCode?: number } = {}) {
  const commands: ChildProcess.StandardCommand[] = [];
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) throw new Error("Expected a standard command");
    commands.push(command);
    const owner = isOwnerBuild(command);
    const stdout = Stream.fromIterable(
      (owner ? [ownerArtifact] : []).map((line) => new TextEncoder().encode(line)),
    );
    const exitCode = owner ? (options.ownerExitCode ?? 0) : 0;
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout,
        stderr: Stream.empty,
        all: stdout,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  const result = Effect.runPromise(
    runDevRunnerWithInput({
      mode,
      dryRun: options.dryRun ?? false,
      t3Home: undefined,
      authToken: undefined,
      noBrowser: undefined,
      autoBootstrapProjectFromCwd: undefined,
      logWebSocketEvents: undefined,
      host: undefined,
      port: undefined,
      devUrl: undefined,
      turboArgs: [],
    }).pipe(
      Effect.scoped,
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provide(NodeServices.layer),
    ),
  );
  return { commands, result };
}

beforeEach(() => {
  reserveRunnerPorts.mockReset().mockReturnValue(Effect.succeed({ serverOffset: 0, webOffset: 0 }));
  vi.stubEnv("BIGBUD_SSH_OWNER", "1");
  vi.stubEnv("BIGBUD_SSH_OWNER_BIN", "stale/owner");
  vi.stubEnv("BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE", "/tmp/old-fixture");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Rust-only SSH owner in development", () => {
  it.each(["dev", "dev:desktop", "dev:server"] as const)(
    "%s builds the owner and hands Turbo only its absolute Cargo path",
    async (mode) => {
      const { commands, result } = launch(mode);
      await result;
      const turbo = commands.find((command) => command.command === "turbo");
      expect(commands.some(isOwnerBuild)).toBe(true);
      expect(turbo?.options.env).toMatchObject({ BIGBUD_SSH_OWNER_BIN: process.execPath });
      // Retired fixture selectors never reach the app.
      expect(turbo?.options.env).not.toHaveProperty("BIGBUD_SSH_OWNER");
      expect(turbo?.options.env).not.toHaveProperty("BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE");
    },
  );

  it("does not build the owner for a web-only mode", async () => {
    const { commands, result } = launch("dev:web");
    await result;
    expect(commands.some(isOwnerBuild)).toBe(false);
    const turbo = commands.find((command) => command.command === "turbo");
    expect(turbo?.options.env).not.toHaveProperty("BIGBUD_SSH_OWNER_BIN");
  });

  it("stops before Turbo when the owner build fails", async () => {
    const { commands, result } = launch("dev", { ownerExitCode: 101 });
    await expect(result).rejects.toMatchObject({ message: "SSH owner build exited with code 101" });
    expect(commands.some((command) => command.command === "turbo")).toBe(false);
  });

  it("spawns nothing in a dry run", async () => {
    const { commands, result } = launch("dev", { dryRun: true });
    await result;
    expect(commands).toEqual([]);
  });
});
