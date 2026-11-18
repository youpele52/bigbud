import * as NodeServices from "@effect/platform-node/NodeServices";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import { afterEach, describe, expect, it } from "vitest";
import { localShellCandidates, probeLocalShellProfiles } from "./ShellProfiles.local";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shell-inventory-"));
  directories.push(directory);
  const executable = path.join(directory, "shell with spaces");
  await writeFile(executable, "not a program: inventory must never execute this file");
  await chmod(executable, 0o700);
  return executable;
}

function inventory(mapping: Readonly<Record<string, string>>, fail = false, stall = false) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* probeLocalShellProfiles({ platform: "linux", env: {} }).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        realPath: (candidate) => {
          if (stall) return Effect.never;
          if (fail) {
            return Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "realPath",
              }),
            );
          }
          const resolved = mapping[candidate];
          return resolved
            ? Effect.succeed(resolved)
            : Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "realPath",
                }),
              );
        },
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer));
}

describe("local shell discovery", () => {
  it("uses bounded absolute Windows candidates and excludes PATH/preview aliases", () => {
    const candidates = localShellCandidates("win32", {
      ProgramFiles: "C:\\Program Files",
      ProgramW6432: "C:\\Program Files",
      SystemRoot: "C:\\Windows",
      ComSpec: "cmd.exe",
      PATH: "C:\\workspace",
    });
    expect(candidates).toEqual([
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Windows\\System32\\cmd.exe",
    ]);
    expect(
      localShellCandidates("win32", { ProgramFiles: "relative", SystemRoot: "relative" }),
    ).toEqual([]);
    expect(localShellCandidates("linux", { PATH: "/workspace" })).toHaveLength(20);
  });

  it("discovers executable files without running them and deduplicates canonical aliases", async () => {
    const executable = await fixture();
    const result = await Effect.runPromise(
      inventory({ "/bin/bash": executable, "/usr/bin/bash": executable }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      host: { kind: "local", hostId: "local" },
      executable,
      kind: "bash",
      args: [],
      availability: "available",
      integration: { status: "unavailable", reason: "not-qualified" },
    });
  });

  it.skipIf(process.platform === "win32")(
    "does not advertise nonexecutable files or directories",
    async () => {
      const executable = await fixture();
      await chmod(executable, 0o600);
      expect(
        await Effect.runPromise(
          inventory({ "/bin/bash": executable, "/bin/zsh": path.dirname(executable) }),
        ),
      ).toEqual([]);
    },
  );

  it("retains fixed zsh argv separately from the executable path", async () => {
    const executable = await fixture();
    const result = await Effect.runPromise(inventory({ "/bin/zsh": executable }));
    expect(result[0]?.args).toEqual(["-o", "nopromptsp"]);
    expect(result[0]?.executable).toBe(executable);
  });

  it("bounds a stalled filesystem probe", async () => {
    const failure = await Effect.runPromise(inventory({}, false, true).pipe(Effect.flip));
    expect(failure.reason).toBe("timed-out");
  });

  it("reports unsafe executable identities as typed probe failures", async () => {
    const executable = await fixture();
    const unsafePath = `${executable}\nunsafe`;
    await writeFile(unsafePath, "never execute");
    await chmod(unsafePath, 0o700);
    const failure = await Effect.runPromise(
      inventory({ "/bin/bash": unsafePath }).pipe(Effect.flip),
    );
    expect(failure.reason).toBe("probe-failed");
  });

  it("reports probe failure distinctly from a successful empty inventory", async () => {
    expect(await Effect.runPromise(inventory({}))).toEqual([]);
    const failure = await Effect.runPromise(inventory({}, true).pipe(Effect.flip));
    expect(failure.reason).toBe("probe-failed");
  });
});
