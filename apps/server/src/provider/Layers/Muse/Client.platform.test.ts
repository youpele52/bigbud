import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  museInstallerCandidates,
  museNativeWorkspaceRoot,
  museVerbatimPath,
  resolveMuseLaunch,
  resolveOfficialShimBinary,
} from "./Client.platform.ts";

const scratch = mkdtempSync(join(tmpdir(), "muse-platform-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Lay out what dev.meta.ai/install.ps1 produces in %LOCALAPPDATA%\Programs\muse. */
function officialWindowsInstall(name: string, version: string, withBinary = true): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "muse.cmd"), "@echo off\r\n");
  writeFileSync(join(dir, ".muse-launcher.ps1"), "# launcher\n");
  writeFileSync(join(dir, ".muse-version"), `${version}\n`);
  if (withBinary) writeFileSync(join(dir, `muse-bin-${version}.exe`), "");
  return join(dir, "muse.cmd");
}

const CMD = "C:\\Windows\\system32\\cmd.exe";
const onWindows = (resolved: string | null, env: NodeJS.ProcessEnv = { ComSpec: CMD }) =>
  resolveMuseLaunch("muse", "win32", env, () => resolved);

describe("Muse launch resolution", () => {
  it("runs the binary directly on macOS and Linux", () => {
    expect(resolveMuseLaunch("muse", "darwin", {}, () => null)).toEqual({
      command: "muse",
      args: ["serve"],
    });
    expect(resolveMuseLaunch("/opt/muse/bin/muse", "linux", {}, (c) => c)).toEqual({
      command: "/opt/muse/bin/muse",
      args: ["serve"],
    });
  });

  it("runs a PATHEXT-resolved exe directly on Windows", () => {
    expect(onWindows("C:\\Muse\\muse.exe")).toEqual({
      command: "C:\\Muse\\muse.exe",
      args: ["serve"],
    });
  });

  it("runs a .cmd launcher under ComSpec with /d /c, keeping spaced paths intact", () => {
    const spaced = "C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\muse\\muse.cmd";
    expect(onWindows(spaced)).toEqual({ command: CMD, args: ["/d", "/c", "@", spaced, "serve"] });
    const spacedAmpersand = "C:\\Users\\R&D Team\\muse.cmd";
    expect(onWindows(spacedAmpersand).args).toEqual(["/d", "/c", "@", spacedAmpersand, "serve"]);
  });

  it("escapes cmd metacharacters in unspaced launcher paths", () => {
    expect(onWindows("C:\\Users\\R&D(1)\\muse.cmd").args).toEqual([
      "/d",
      "/c",
      "C:\\Users\\R^&D^(1^)\\muse.cmd",
      "serve",
    ]);
  });

  it("falls back to SystemRoot cmd.exe for .bat and to the raw name when unresolved", () => {
    expect(onWindows("C:\\Muse\\muse.bat", { SYSTEMROOT: "C:\\Windows" }).command).toBe(
      "C:\\Windows\\System32\\cmd.exe",
    );
    expect(onWindows(null)).toEqual({ command: "muse", args: ["serve"] });
  });
});

describe("Muse workspace root", () => {
  it("writes Windows roots in verbatim form", () => {
    expect(museVerbatimPath("C:\\Users\\Person\\repo")).toBe("\\\\?\\C:\\Users\\Person\\repo");
    expect(museVerbatimPath("\\\\server\\share\\repo")).toBe("\\\\?\\UNC\\server\\share\\repo");
    expect(museVerbatimPath("\\\\?\\C:\\repo")).toBe("\\\\?\\C:\\repo");
  });

  it("derives the wire root per platform", () => {
    expect(museNativeWorkspaceRoot("C:/work/repo", "win32")).toBe("\\\\?\\C:\\work\\repo");
    expect(museNativeWorkspaceRoot("/private/tmp/repo", "darwin")).toBe("/private/tmp/repo");
    expect(museNativeWorkspaceRoot("/home/me/repo", "linux")).toBe("/home/me/repo");
  });
});

describe("Muse official installer layout", () => {
  it("starts the real binary behind the official Windows shim, skipping cmd and PowerShell", () => {
    const shim = officialWindowsInstall("official", "1.4.14-R7309.1");
    const binary = join(scratch, "official", "muse-bin-1.4.14-R7309.1.exe");
    expect(resolveOfficialShimBinary(shim)).toBe(binary);
    expect(resolveMuseLaunch("muse", "win32", { ComSpec: CMD }, () => shim)).toEqual({
      command: binary,
      args: ["serve"],
    });
  });

  it("keeps the shim path when the layout is not the official one", () => {
    const badVersion = officialWindowsInstall("bad-version", "../../evil", false);
    expect(resolveOfficialShimBinary(badVersion)).toBeUndefined();
    const missing = officialWindowsInstall("missing-binary", "1.4.14-R7309.1", false);
    expect(resolveOfficialShimBinary(missing)).toBeUndefined();
    expect(resolveMuseLaunch("muse", "win32", { ComSpec: CMD }, () => missing).command).toBe(CMD);
  });

  it("falls back to the installer location only for the default name", () => {
    expect(museInstallerCandidates("win32", { LOCALAPPDATA: "C:/Users/me/AppData/Local" })).toEqual(
      [join("C:/Users/me/AppData/Local", "Programs", "muse", "muse.cmd")],
    );
    expect(
      museInstallerCandidates("linux", { HOME: "/home/me", MUSE_INSTALL_DIR: "/opt/m" }),
    ).toEqual([join("/opt/m", "muse"), join("/home/me", ".local", "bin", "muse")]);
    const installed = join("/home/me", ".local", "bin", "muse");
    const onlyInstalled = (command: string) => (command === installed ? installed : null);
    expect(resolveMuseLaunch("muse", "linux", { HOME: "/home/me" }, onlyInstalled).command).toBe(
      installed,
    );
    expect(
      resolveMuseLaunch("/custom/muse", "linux", { HOME: "/home/me" }, onlyInstalled).command,
    ).toBe("/custom/muse");
  });
});
