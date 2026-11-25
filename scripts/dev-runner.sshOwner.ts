import { constants } from "node:fs";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEV_SSH_OWNER_GUARDED_ENV,
  DEV_SSH_OWNER_LINUX_JUMP_ENV,
  DEV_SSH_OWNER_RETAIN_ENV,
  DEV_SSH_OWNER_WINDOWS_FIXTURE_ENV,
} from "@bigbud/shared/DevLauncher";

import { Deferred, Effect, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

import { DevRunnerError } from "./dev-runner.lib.ts";

const binaryName = "bigbud-ssh-owner";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const buildArgs = [
  "build",
  "--locked",
  "--package",
  binaryName,
  "--bin",
  binaryName,
  "--message-format=json-render-diagnostics",
];

function cargoExecutable(line: string): string | undefined {
  try {
    const artifact = JSON.parse(line);
    if (
      artifact?.reason === "compiler-artifact" &&
      artifact.target?.name === binaryName &&
      Array.isArray(artifact.target.kind) &&
      artifact.target.kind.includes("bin") &&
      typeof artifact.executable === "string" &&
      artifact.executable.length > 0
    ) {
      return resolve(repoRoot, artifact.executable);
    }
  } catch {
    // Cargo wrappers can write non-JSON lines; only Cargo's binary artifact is needed.
  }
  return undefined;
}

type PickerMode = "dev" | "dev:desktop";

export function withoutDevSshOwnerEnv(baseEnv: NodeJS.ProcessEnv) {
  const env = { ...baseEnv };
  delete env.BIGBUD_SSH_OWNER;
  delete env.BIGBUD_SSH_OWNER_BIN;
  delete env.BIGBUD_SSH_OWNER_NORMAL_DEV_READY;
  delete env.BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE;
  delete env[DEV_SSH_OWNER_WINDOWS_FIXTURE_ENV];
  delete env[DEV_SSH_OWNER_LINUX_JUMP_ENV];
  delete env[DEV_SSH_OWNER_GUARDED_ENV];
  delete env.BIGBUD_SSH_OWNER_GUARDED_WRITE_APPLY_PROOF;
  delete env.BIGBUD_SSH_OWNER_GUARDED_WRITE_STAGE_PROOF;
  delete env[DEV_SSH_OWNER_RETAIN_ENV];
  return env;
}

export const prepareDevSshOwnerEnv = Effect.fn("prepareDevSshOwnerEnv")(function* (
  baseEnv: NodeJS.ProcessEnv,
) {
  const env = withoutDevSshOwnerEnv(baseEnv);
  yield* Effect.logInfo("[dev-runner] Building the local SSH owner...");
  const build = yield* ChildProcess.make("cargo", buildArgs, {
    cwd: repoRoot,
    env,
    extendEnv: false,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
    detached: false,
    forceKillAfter: "1500 millis",
  });
  // Use Cargo's artifact rather than assuming target/debug (e.g. CARGO_TARGET_DIR,
  // an explicit Cargo target, or Windows).
  const executable = yield* build.stdout.pipe(
    Stream.decodeText(),
    // splitLines emits only delimited records; flush an unterminated final line.
    Stream.concat(Stream.make("\n")),
    Stream.splitLines,
    Stream.runFold(
      (): string | undefined => undefined,
      (current, line) => cargoExecutable(line) ?? current,
    ),
  );
  const exitCode = yield* build.exitCode;
  if (exitCode !== 0) {
    return yield* new DevRunnerError({ message: `SSH owner build exited with code ${exitCode}` });
  }
  if (executable === undefined) {
    return yield* new DevRunnerError({
      message: `Cargo did not report a ${binaryName} executable`,
    });
  }
  yield* Effect.tryPromise({
    try: async () => {
      if (!(await stat(executable)).isFile()) throw new Error("Not a file");
      await access(executable, constants.X_OK);
    },
    catch: (cause) =>
      new DevRunnerError({
        message: `SSH owner executable is unavailable at ${executable}`,
        cause,
      }),
  });

  env.BIGBUD_SSH_OWNER = "1";
  env.BIGBUD_SSH_OWNER_BIN = executable;
  return env;
});

const pickerEntry = resolve(repoRoot, "apps/server/src/ssh/sshOwnerDevPicker.main.ts");
const electronEntry = fileURLToPath(new URL("./ssh-owner-picker-electron.cjs", import.meta.url));
const requireDesktop = createRequire(resolve(repoRoot, "apps/desktop/package.json"));
const pickerUrlPrefix = "BIGBUD_SSH_OWNER_PICKER_URL=";
const processLifetime = { detached: false, forceKillAfter: "1500 millis" } as const;

function isPickerUrl(value: string): boolean {
  if (/\s/u.test(value)) return false;
  const url = URL.parse(value);
  return (
    url !== null &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.hostname === "127.0.0.1" &&
    url.username === "" &&
    url.password === "" &&
    url.hash.length > 1
  );
}

const openDesktopPicker = Effect.fn("openDesktopPicker")(function* (
  url: string,
  baseEnv: NodeJS.ProcessEnv,
) {
  const electron = yield* Effect.try({
    try: (): string => {
      const executable: unknown = requireDesktop("electron");
      if (typeof executable !== "string") throw new Error("Missing Electron executable");
      return executable;
    },
    catch: () =>
      new DevRunnerError({ message: "Could not resolve the desktop Electron installation" }),
  });
  const profile = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "bigbud-ssh-owner-picker-")),
      catch: () =>
        new DevRunnerError({ message: "Could not create a temporary SSH picker profile" }),
    }),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  );
  // Keep the token out of command arguments and Electron's output.
  const env: NodeJS.ProcessEnv = {
    ...withoutDevSshOwnerEnv(baseEnv),
    BIGBUD_SSH_OWNER_PICKER_URL: url,
    BIGBUD_SSH_OWNER_PICKER_PROFILE: profile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const desktop = yield* ChildProcess.make(electron, [electronEntry], {
    ...processLifetime,
    extendEnv: false,
    env,
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = yield* desktop.exitCode;
  if (code !== 0) {
    return yield* new DevRunnerError({
      message: `SSH owner picker window exited with code ${code}`,
    });
  }
});

export const runDevSshOwnerPicker = Effect.fn("runDevSshOwnerPicker")(function* (
  mode: PickerMode,
  dryRun: boolean,
  baseEnv: NodeJS.ProcessEnv,
) {
  if (dryRun) {
    yield* Effect.logInfo(`[dev-runner] mode=${mode} isolated SSH owner picker (dry run)`);
    return;
  }

  const env = yield* prepareDevSshOwnerEnv(baseEnv);
  const picker = yield* ChildProcess.make("bun", [pickerEntry], {
    ...processLifetime,
    cwd: repoRoot,
    extendEnv: false,
    env,
    stdout: "pipe",
    stderr: "inherit",
  });
  const ready = yield* Deferred.make<string, DevRunnerError>();
  // Drain stdout throughout the server's lifetime, but never echo extra lines or a rejected URL.
  yield* picker.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => {
      if (!line.startsWith(pickerUrlPrefix)) return Effect.void;
      const url = line.slice(pickerUrlPrefix.length);
      return isPickerUrl(url)
        ? Deferred.succeed(ready, url)
        : Deferred.fail(
            ready,
            new DevRunnerError({ message: "SSH owner picker reported an invalid URL" }),
          );
    }),
    Effect.matchEffect({
      onFailure: () =>
        Deferred.fail(
          ready,
          new DevRunnerError({ message: "Could not read SSH owner picker readiness" }),
        ),
      onSuccess: () =>
        Deferred.fail(
          ready,
          new DevRunnerError({
            message: "SSH owner picker closed stdout before reporting its URL",
          }),
        ),
    }),
    Effect.forkScoped,
  );

  yield* Effect.raceFirst(
    Deferred.await(ready).pipe(
      Effect.flatMap((url) =>
        mode === "dev:desktop"
          ? openDesktopPicker(url, baseEnv)
          : Effect.sync(() => console.log(url)).pipe(Effect.andThen(Effect.never)),
      ),
    ),
    picker.exitCode.pipe(
      Effect.flatMap((code) =>
        Effect.fail(
          new DevRunnerError({ message: `SSH owner picker server exited with code ${code}` }),
        ),
      ),
    ),
  );
}, Effect.scoped);
