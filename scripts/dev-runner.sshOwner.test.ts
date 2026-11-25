import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  DEV_SSH_OWNER_LINUX_JUMP_ENV,
  DEV_SSH_OWNER_GUARDED_ENV,
  DEV_SSH_OWNER_GUARDED_MARKER,
  DEV_SSH_OWNER_LINUX_JUMP_MARKER,
  DEV_SSH_OWNER_WINDOWS_FIXTURE_ENV,
  DEV_SSH_OWNER_WINDOWS_FIXTURE_MARKER,
} from "@bigbud/shared/DevLauncher";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MODE_ARGS, runDevRunnerWithInput } from "./dev-runner.ts";
import { runDevSshOwnerPicker } from "./dev-runner.sshOwner.ts";
import type { DevMode } from "./dev-runner.lib.ts";

const reserveRunnerPorts = vi.hoisted(() => vi.fn());
const electronExecutable = vi.hoisted(() => "/installed/electron");
vi.mock("./dev-runner.coordination.ts", () => ({ reserveRunnerPorts }));
vi.mock(import("node:module"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    createRequire: (from: string | URL) => {
      const require = original.createRequire(from);
      return String(from).endsWith("/apps/desktop/package.json")
        ? new Proxy(require, { apply: () => electronExecutable })
        : require;
    },
  };
});

const pickerUrl = "http://127.0.0.1:12345/#page-token";
const pickerMarker = `BIGBUD_SSH_OWNER_PICKER_URL=${pickerUrl}\n`;
const executableArtifact = (executable: string, name = "bigbud-ssh-owner", kind = ["bin"]) =>
  JSON.stringify({ reason: "compiler-artifact", target: { name, kind }, executable });

function launch(
  mode: DevMode,
  options: {
    dryRun?: boolean;
    runStandalonePicker?: boolean;
    t3Home?: string;
    stdout?: string;
    exitCode?: number;
    pickerStdout?: string[];
    pickerExitCode?: number;
    desktopExitCode?: number;
    onDesktopSpawn?: (command: ChildProcess.StandardCommand) => void;
  },
) {
  const commands: ChildProcess.StandardCommand[] = [];
  const controller = new AbortController();
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) throw new Error("Expected a standard command");
    commands.push(command);
    const isOwner = isOwnerBuild(command);
    const isPicker = command.command === "bun";
    const isDesktop = command.command === electronExecutable;
    if (isDesktop) options.onDesktopSpawn?.(command);
    const lines = isOwner ? [options.stdout ?? ""] : isPicker ? (options.pickerStdout ?? []) : [];
    const stdout = Stream.fromIterable(lines.map((line) => new TextEncoder().encode(line)));
    const exitCode = isOwner
      ? (options.exitCode ?? 0)
      : isPicker
        ? options.pickerExitCode
        : isDesktop
          ? (options.desktopExitCode ?? 0)
          : 0;
    const output = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode:
        exitCode === undefined
          ? Effect.never
          : Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout,
      stderr: Stream.empty,
      all: stdout,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
    return Effect.succeed(output);
  });
  const normalApp = runDevRunnerWithInput({
    mode,
    dryRun: options.dryRun ?? false,
    t3Home: options.t3Home,
    authToken: undefined,
    noBrowser: undefined,
    autoBootstrapProjectFromCwd: undefined,
    logWebSocketEvents: undefined,
    host: undefined,
    port: undefined,
    devUrl: undefined,
    turboArgs: [],
  });
  const run =
    options.runStandalonePicker && (mode === "dev" || mode === "dev:desktop")
      ? runDevSshOwnerPicker(mode, options.dryRun ?? false, process.env)
      : normalApp;
  const result = Effect.runPromise(
    run.pipe(
      Effect.scoped,
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provide(NodeServices.layer),
    ),
    { signal: controller.signal },
  );
  return { commands, result, stop: () => controller.abort() };
}

const isOwnerBuild = (command: ChildProcess.StandardCommand) =>
  command.command === "cargo" && command.args.includes("bigbud-ssh-owner");

const stubOwnerEnvironment = (optIn: string | undefined) => {
  vi.stubEnv("BIGBUD_SSH_OWNER", optIn);
  vi.stubEnv("BIGBUD_SSH_OWNER_BIN", "stale/owner");
};

beforeEach(() =>
  reserveRunnerPorts.mockReset().mockReturnValue(Effect.succeed({ serverOffset: 0, webOffset: 0 })),
);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const expectIsolatedPicker = (commands: ChildProcess.StandardCommand[]) => {
  expect(reserveRunnerPorts).not.toHaveBeenCalled();
  expect(commands[0]?.args).toEqual([
    "build",
    "--locked",
    "--package",
    "bigbud-ssh-owner",
    "--bin",
    "bigbud-ssh-owner",
    "--message-format=json-render-diagnostics",
  ]);
  expect(commands[1]?.args).toEqual([
    expect.stringMatching(/\/apps\/server\/src\/ssh\/sshOwnerDevPicker\.main\.ts$/u),
  ]);
  expect(commands[1]?.options).toMatchObject({
    extendEnv: false,
    detached: false,
    forceKillAfter: "1500 millis",
    env: { BIGBUD_SSH_OWNER: "1", BIGBUD_SSH_OWNER_BIN: process.execPath },
  });
  expect(process.env.BIGBUD_SSH_OWNER_BIN).toBe("stale/owner");
};

describe("Standalone SSH owner picker fixture", () => {
  it("runs only Cargo and the isolated Bun entry, printing the exact browser link once", async () => {
    stubOwnerEnvironment("1");
    const print = vi.spyOn(console, "log").mockImplementation(() => {});
    const { commands, result, stop } = launch("dev", {
      runStandalonePicker: true,
      stdout: [
        "Cargo wrapper output",
        executableArtifact("ignored", "bigbud-ssh-owner", ["custom-build"]),
        executableArtifact(process.execPath),
        executableArtifact("ignored", "different-binary"),
      ].join("\n"),
      pickerStdout: [
        "other output\n",
        pickerMarker.slice(0, 18),
        pickerMarker.slice(18),
        pickerMarker,
      ],
    });
    const interrupted = expect(result).rejects.toThrow(/interrupt/i);
    try {
      await vi.waitFor(() => expect(print).toHaveBeenCalledWith(pickerUrl));
      expect(print.mock.calls.filter(([line]) => String(line).includes("page-token"))).toEqual([
        [pickerUrl],
      ]);
      expect(commands.map((command) => command.command)).toEqual(["cargo", "bun"]);
      expectIsolatedPicker(commands);
    } finally {
      stop();
      await interrupted;
    }
  });
  it.each([0, 7])(
    "opens only the local Electron picker and removes its profile on exit (%s)",
    async (code) => {
      stubOwnerEnvironment("1");
      vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
      const print = vi.spyOn(console, "log").mockImplementation(() => {});
      let profile: string | undefined;
      const { commands, result } = launch("dev:desktop", {
        runStandalonePicker: true,
        stdout: executableArtifact(process.execPath),
        pickerStdout: [pickerMarker],
        desktopExitCode: code,
        onDesktopSpawn: (command) => {
          profile = command.options.env?.BIGBUD_SSH_OWNER_PICKER_PROFILE;
          expect(profile && existsSync(profile)).toBe(true);
        },
      });
      if (code === 0) await result;
      else await expect(result).rejects.toThrow(`window exited with code ${code}`);
      expect(commands.map((command) => command.command)).toEqual([
        "cargo",
        "bun",
        electronExecutable,
      ]);
      expectIsolatedPicker(commands);
      expect(commands[2]?.args).toEqual([
        expect.stringMatching(/\/scripts\/ssh-owner-picker-electron\.cjs$/u),
      ]);
      expect(commands[2]?.options).toMatchObject({
        extendEnv: false,
        detached: false,
        forceKillAfter: "1500 millis",
        env: { BIGBUD_SSH_OWNER_PICKER_URL: pickerUrl },
      });
      expect(commands[2]?.options.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
      expect(typeof profile).toBe("string");
      expect(profile && existsSync(profile)).toBe(false);
      expect(print.mock.calls.flat().join(" ")).not.toContain("page-token");
    },
  );
  it.each([
    [[], "closed stdout"],
    [["BIGBUD_SSH_OWNER_PICKER_URL=http://example.test/#page-token\n"], "reported an invalid URL"],
    [["BIGBUD_SSH_OWNER_PICKER_URL=http://127.0.0.1:12345/\n"], "reported an invalid URL"],
  ] as const)("fails closed on invalid readiness (%j)", async (stdout, error) => {
    stubOwnerEnvironment("1");
    const { commands, result } = launch("dev:desktop", {
      runStandalonePicker: true,
      stdout: executableArtifact(process.execPath),
      pickerStdout: [...stdout],
    });
    const failure: unknown = await result.catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain(error);
    expect(String(failure)).not.toContain("page-token");
    expect(commands.map((command) => command.command)).toEqual(["cargo", "bun"]);
  });
});

describe("Normal app SSH owner development", () => {
  const originalPlatform = process.platform;
  afterEach(() => Object.defineProperty(process, "platform", { value: originalPlatform }));
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.stubEnv("BIGBUD_SSH_OWNER_NORMAL_DEV_READY", undefined);
    vi.stubEnv("BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE", "/stale/base");
  });
  it.each([undefined, "fixture.json", "\\\\host\\share\\fixture.json"])(
    "rejects Windows opt-in without a local fixture (%s)",
    async (manifest) => {
      stubOwnerEnvironment("1");
      vi.stubEnv("BIGBUD_SSH_OWNER_WINDOWS_FIXTURE", manifest);
      Object.defineProperty(process, "platform", { value: "win32" });
      const { commands, result } = launch("dev", {});
      await expect(result).rejects.toThrow("must point to an approved disposable fixture");
      expect(commands).toEqual([]);
    },
  );
  it("passes the selected Windows manifest only via the new private profile", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    stubOwnerEnvironment("1");
    const manifest = String.raw`C:\bigbud-dev\picker\fixture.json`;
    vi.stubEnv(DEV_SSH_OWNER_WINDOWS_FIXTURE_ENV, manifest);
    const { commands, result } = launch("dev", { stdout: executableArtifact(process.execPath) });
    await result;
    const env = commands.at(-1)?.options.env;
    const profile = env?.BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE;
    expect(profile).toBeTruthy();
    if (!profile) return;
    try {
      expect(env).not.toHaveProperty(DEV_SSH_OWNER_WINDOWS_FIXTURE_ENV);
      expect(await readFile(join(profile, DEV_SSH_OWNER_WINDOWS_FIXTURE_MARKER), "utf8")).toBe(
        manifest,
      );
    } finally {
      if (/bigbud-ssh-owner-dev-[a-zA-Z0-9]{6}$/.test(profile))
        await rm(profile, { recursive: true, force: true });
    }
  });

  it.each([
    ["darwin", "dev"],
    ["darwin", "dev:desktop"],
    ["linux", "dev"],
    ["linux", "dev:desktop"],
    ["linux", "dev", true],
  ] as const)(
    "starts the regular %s %s tasks with a fresh profile",
    async (platform, mode, jump?: true) => {
      Object.defineProperty(process, "platform", { value: platform });
      stubOwnerEnvironment("1");
      vi.stubEnv(DEV_SSH_OWNER_LINUX_JUMP_ENV, jump ? "approved-disposable" : undefined);
      const guarded = platform === "darwin" && mode === "dev";
      vi.stubEnv(DEV_SSH_OWNER_GUARDED_ENV, guarded ? "approved-disposable" : undefined);
      const normalHome = "/normal/profile";
      const { commands, result } = launch(mode, {
        stdout: executableArtifact(process.execPath),
        t3Home: normalHome,
      });
      let profile: string | undefined;
      try {
        await result;
        const turbo = commands.at(-1);
        const env = turbo?.options.env;
        profile = env?.BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE;
        expect(reserveRunnerPorts).toHaveBeenCalledOnce();
        expect(commands.map((command) => command.command)).toEqual(["cargo", "cargo", "turbo"]);
        expect(turbo?.args).toEqual(
          MODE_ARGS[mode].filter(
            (arg) =>
              arg !== "--filter=@bigbud/mobile-web" &&
              (platform !== "linux" || arg !== "--filter=@bigbud/contracts"),
          ),
        );
        expect(profile).toMatch(/^\/tmp\/bigbud-ssh-owner-dev-[A-Za-z0-9]{6}$/u);
        expect(profile).not.toBe(normalHome);
        expect(profile && existsSync(join(profile, "electron"))).toBe(true);
        expect(profile && existsSync(join(profile, DEV_SSH_OWNER_LINUX_JUMP_MARKER))).toBe(
          jump === true,
        );
        expect(env).not.toHaveProperty(DEV_SSH_OWNER_LINUX_JUMP_ENV);
        expect(env).not.toHaveProperty(DEV_SSH_OWNER_GUARDED_ENV);
        expect(profile && existsSync(join(profile, DEV_SSH_OWNER_GUARDED_MARKER))).toBe(guarded);
        expect(env).toMatchObject({
          BIGBUD_HOME: profile,
          BIGBUD_SSH_OWNER: "1",
          BIGBUD_SSH_OWNER_BIN: process.execPath,
          BIGBUD_SSH_OWNER_NORMAL_DEV_READY: "1",
        });
        expect(process.env.BIGBUD_SSH_OWNER_BIN).toBe("stale/owner");
      } finally {
        if (profile?.startsWith("/tmp/bigbud-ssh-owner-dev-"))
          await rm(profile, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["dev", undefined],
    ["dev:desktop", "0"],
    ["dev", "true"],
    ["dev:server", "1"],
    ["dev:web", "1"],
    ["dev:mobile-web", "1"],
  ] as const)("does not enable SSH owner in %s with flag %s", async (mode, flag) => {
    stubOwnerEnvironment(flag);
    const { commands, result } = launch(mode, {});
    await result;
    expect(commands.some(isOwnerBuild)).toBe(false);
    const turbo = commands.at(-1);
    expect(turbo?.command).toBe("turbo");
    expect(turbo?.options.env).not.toHaveProperty("BIGBUD_SSH_OWNER");
    expect(turbo?.options.env).not.toHaveProperty("BIGBUD_SSH_OWNER_BIN");
    expect(turbo?.options.env).not.toHaveProperty("BIGBUD_SSH_OWNER_NORMAL_DEV_READY");
    expect(turbo?.options.env).not.toHaveProperty("BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE");
  });
  it("does not spawn any child in an opted-in dry run", async () => {
    stubOwnerEnvironment("1");
    const { commands, result } = launch("dev", { dryRun: true });
    await result;
    expect(commands).toEqual([]);
  });

  it.each([
    [{ stdout: executableArtifact(process.execPath), exitCode: 1 }, "build exited with code 1"],
    [{ stdout: "" }, "did not report a bigbud-ssh-owner executable"],
  ] as const)("stops before Turbo on invalid build output (%j)", async (options, error) => {
    stubOwnerEnvironment("1");
    const { commands, result } = launch("dev", options);
    await expect(result).rejects.toThrow(error);
    expect(commands.some((command) => command.command === "turbo")).toBe(false);
  });
  it("stops before Turbo when the reported executable is missing", async () => {
    stubOwnerEnvironment("1");
    const temporary = await mkdtemp(join(tmpdir(), "bigbud-dev-ssh-owner-"));
    try {
      const { commands, result } = launch("dev", {
        stdout: executableArtifact(join(temporary, "missing")),
      });
      await expect(result).rejects.toThrow("SSH owner executable is unavailable");
      expect(commands.some((command) => command.command === "turbo")).toBe(false);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
