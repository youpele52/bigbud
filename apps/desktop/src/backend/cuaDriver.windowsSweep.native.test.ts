import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { sweepWindowsCuaDriverProcesses } from "./cuaDriver.windowsSweep";
import { assertWindowsFilesReplaceable } from "./windowsFileReplaceability";

const nativeIt = process.platform === "win32" ? it : it.skip;
const cleanupDirectories: string[] = [];

async function stopChild(
  child: ChildProcess.ChildProcess,
  exited: Promise<unknown[]>,
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited;
}

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Windows CUA sweep native helper", () => {
  nativeIt("compiles and returns stock-PowerShell JSON for a safe no-match dry run", () => {
    expect(() =>
      sweepWindowsCuaDriverProcesses({
        executablePath: process.execPath,
        dryRun: true,
      }),
    ).not.toThrow();
  });

  nativeIt(
    "terminates only a controlled copied executable with an exact handle path",
    async () => {
      const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "bigbud-cua-native-大芽-"));
      cleanupDirectories.push(directory);
      const executablePath = Path.join(directory, "cua-driver.exe");
      FS.copyFileSync(process.execPath, executablePath);
      const child = ChildProcess.spawn(
        executablePath,
        ["-e", "setInterval(() => undefined, 1_000)"],
        { stdio: "ignore", windowsHide: true },
      );
      const exited = once(child, "exit");
      try {
        await once(child, "spawn");
        sweepWindowsCuaDriverProcesses({ executablePath });
        await exited;
        expect(child.exitCode).toBe(1);
        expect(child.signalCode).toBeNull();
        expect(() =>
          assertWindowsFilesReplaceable({
            targets: [{ label: "the CUA driver", path: executablePath }],
          }),
        ).not.toThrow();
      } finally {
        await stopChild(child, exited);
      }
    },
    75_000,
  );

  nativeIt(
    "detects a differently named hard-link image until that process exits",
    async () => {
      const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "bigbud-cua-identity-"));
      cleanupDirectories.push(directory);
      const executablePath = Path.join(directory, "cua-driver.exe");
      const aliasPath = Path.join(directory, "differently-named-alias.exe");
      FS.copyFileSync(process.execPath, executablePath);
      FS.linkSync(executablePath, aliasPath);
      const child = ChildProcess.spawn(aliasPath, ["-e", "setInterval(() => undefined, 1_000)"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const exited = once(child, "exit");
      try {
        await once(child, "spawn");
        expect(() => sweepWindowsCuaDriverProcesses({ executablePath })).not.toThrow();
        expect(() =>
          assertWindowsFilesReplaceable({
            targets: [{ label: "the CUA driver", path: executablePath }],
          }),
        ).toThrow("could not prove the CUA driver is replaceable");
        child.kill("SIGKILL");
        await exited;
        expect(() =>
          assertWindowsFilesReplaceable({
            targets: [{ label: "the CUA driver", path: executablePath }],
          }),
        ).not.toThrow();
      } finally {
        await stopChild(child, exited);
      }
    },
    75_000,
  );

  nativeIt(
    "leaves a same-name process running when file identity is definitely different",
    async () => {
      const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "bigbud-cua-different-"));
      cleanupDirectories.push(directory);
      const executablePath = Path.join(directory, "cua-driver.exe");
      const differentPath = Path.join(directory, "different-driver.exe");
      FS.copyFileSync(process.execPath, executablePath);
      FS.copyFileSync(process.execPath, differentPath);
      const child = ChildProcess.spawn(
        executablePath,
        ["-e", "setInterval(() => undefined, 1_000)"],
        { stdio: "ignore", windowsHide: true },
      );
      const exited = once(child, "exit");
      try {
        await once(child, "spawn");
        sweepWindowsCuaDriverProcesses({ executablePath: differentPath, dryRun: true });
        expect(child.exitCode).toBeNull();
      } finally {
        await stopChild(child, exited);
      }
    },
    75_000,
  );
});
