import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEV_SSH_OWNER_PROFILE_PREFIX,
  DEV_SSH_OWNER_GUARDED_APPROVAL,
  DEV_SSH_OWNER_GUARDED_ENV,
  supportsDevSshOwnerGuardedFixture,
  DEV_SSH_OWNER_GUARDED_MARKER,
  DEV_SSH_OWNER_RETAIN_ENV,
  DEV_SSH_OWNER_RETAIN_MARKER,
  DEV_SSH_OWNER_LINUX_JUMP_ENV,
  DEV_SSH_OWNER_LINUX_JUMP_MARKER,
  DEV_SSH_OWNER_WINDOWS_FIXTURE_ENV,
  DEV_SSH_OWNER_WINDOWS_FIXTURE_MARKER,
} from "@bigbud/shared/DevLauncher";
import { Effect } from "effect";

import { DevRunnerError, type DevMode } from "./dev-runner.lib.ts";
import { prepareDevSshOwnerEnv } from "./dev-runner.sshOwner.ts";

export function resolveNormalDevSshOwner(mode: DevMode, env: NodeJS.ProcessEnv) {
  const retain = env[DEV_SSH_OWNER_RETAIN_ENV];
  if (
    retain !== undefined &&
    (retain !== "1" ||
      mode !== "dev" ||
      process.platform !== "darwin" ||
      env.BIGBUD_SSH_OWNER !== "1" ||
      !process.getuid?.())
  ) {
    return new DevRunnerError({
      message:
        "SSH owner retention requires the non-root macOS Bun dev fixture (BIGBUD_SSH_OWNER=1).",
    });
  }
  if ((mode !== "dev" && mode !== "dev:desktop") || env.BIGBUD_SSH_OWNER !== "1") return false;
  if (process.platform === "win32") {
    return (
      windowsFixturePath(env) !== undefined ||
      new DevRunnerError({
        message: `${DEV_SSH_OWNER_WINDOWS_FIXTURE_ENV} must point to an approved disposable fixture manifest on a local Windows drive. No legacy app was started.`,
      })
    );
  }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return new DevRunnerError({
      message:
        "Normal app SSH owner development does not support this platform. No legacy app was started.",
    });
  }
  return true;
}

function windowsFixturePath(env: NodeJS.ProcessEnv): string | undefined {
  const value = env[DEV_SSH_OWNER_WINDOWS_FIXTURE_ENV];
  return value &&
    value.length <= 1024 &&
    /^[A-Za-z]:[\\/]/.test(value) &&
    [...value].every((character) => character.charCodeAt(0) >= 0x20)
    ? value
    : undefined;
}

export const prepareNormalDevSshOwner = Effect.fn("prepareNormalDevSshOwner")(function* (
  baseEnv: NodeJS.ProcessEnv,
  operatorEnv: NodeJS.ProcessEnv = baseEnv,
) {
  const jumpOptIn = operatorEnv[DEV_SSH_OWNER_LINUX_JUMP_ENV];
  if (
    jumpOptIn !== undefined &&
    (process.platform !== "linux" ||
      !["approved-disposable", "first-use-disposable"].includes(jumpOptIn))
  )
    return yield* new DevRunnerError({ message: "Invalid disposable Linux SSH jump selection." });
  const fixture = process.platform === "win32" ? windowsFixturePath(operatorEnv) : undefined;
  if (process.platform === "win32" && !fixture)
    return yield* new DevRunnerError({
      message: "Windows SSH owner fixture selection is missing.",
    });
  const ownerEnv = yield* prepareDevSshOwnerEnv(baseEnv);
  const guarded =
    operatorEnv[DEV_SSH_OWNER_GUARDED_ENV] === DEV_SSH_OWNER_GUARDED_APPROVAL &&
    !jumpOptIn &&
    !fixture &&
    operatorEnv[DEV_SSH_OWNER_RETAIN_ENV] !== "1" &&
    (yield* Effect.promise(supportsDevSshOwnerGuardedFixture));
  // A short, private, fresh base keeps SQLite, ownership locks and Unix sockets separate from
  // all normal profiles, even when the user supplied a --t3-home or BIGBUD_HOME override.
  // Keep it after shutdown: detached app children may still own resources and the profile is
  // useful for inspecting durable Disconnect evidence.
  const baseDir = yield* Effect.tryPromise({
    try: async () => {
      const directory = await mkdtemp(
        join(fixture ? tmpdir() : "/tmp", DEV_SSH_OWNER_PROFILE_PREFIX),
      );
      await mkdir(join(directory, "electron"), { mode: 0o700 });
      if (operatorEnv[DEV_SSH_OWNER_RETAIN_ENV] === "1")
        await writeFile(join(directory, DEV_SSH_OWNER_RETAIN_MARKER), "", {
          flag: "wx",
          mode: 0o600,
        });
      if (guarded)
        await writeFile(
          join(directory, DEV_SSH_OWNER_GUARDED_MARKER),
          DEV_SSH_OWNER_GUARDED_APPROVAL,
          {
            flag: "wx",
            mode: 0o600,
          },
        );
      if (fixture)
        await writeFile(join(directory, DEV_SSH_OWNER_WINDOWS_FIXTURE_MARKER), fixture, {
          flag: "wx",
          mode: 0o600,
        });
      if (jumpOptIn)
        await writeFile(
          join(directory, DEV_SSH_OWNER_LINUX_JUMP_MARKER),
          jumpOptIn === "first-use-disposable" ? "1" : "",
          {
            flag: "wx",
            mode: 0o600,
          },
        );
      return directory;
    },
    catch: (cause) =>
      new DevRunnerError({
        message: "Could not create an isolated SSH owner development profile",
        cause,
      }),
  });
  return {
    baseDir,
    env: {
      BIGBUD_SSH_OWNER: ownerEnv.BIGBUD_SSH_OWNER,
      BIGBUD_SSH_OWNER_BIN: ownerEnv.BIGBUD_SSH_OWNER_BIN,
      BIGBUD_SSH_OWNER_NORMAL_DEV_READY: "1",
      BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE: baseDir,
    },
  };
});
