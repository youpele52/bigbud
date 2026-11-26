/**
 * Development SSH owner: SSH runs only through the Rust owner (S4), so every dev
 * mode that starts the server builds `bigbud-ssh-owner` with Cargo and exports its
 * absolute path as `BIGBUD_SSH_OWNER_BIN`. The server verifies the native header
 * and runs it as the `desktop-dev` profile against the user's own SSH config.
 *
 * @module dev-runner.sshOwner
 */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEV_SSH_OWNER_GUARDED_ENV,
  DEV_SSH_OWNER_LINUX_JUMP_ENV,
  DEV_SSH_OWNER_RETAIN_ENV,
  DEV_SSH_OWNER_WINDOWS_FIXTURE_ENV,
} from "@bigbud/shared/DevLauncher";

import { Effect, Stream } from "effect";
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

  env.BIGBUD_SSH_OWNER_BIN = executable;
  return env;
});
