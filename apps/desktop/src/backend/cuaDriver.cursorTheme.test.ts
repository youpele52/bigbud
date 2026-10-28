import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  CUA_CURSOR_THEME_ID,
  cuaDriverCursorThemePath,
} from "@bigbud/shared/cua-driver/cursorTheme";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareCuaCursorTheme } from "./cuaDriver.cursorTheme";
import { CUA_CURSOR_THEME_ARTIFACT_BASE64 } from "./cuaDriver.cursorTheme.artifact";

const artifact = Buffer.from(CUA_CURSOR_THEME_ARTIFACT_BASE64, "base64");
const temporaryDirectories: string[] = [];

function makeStateHome(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "bigbud-cursor-theme-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("prepareCuaCursorTheme", () => {
  it.each([["0.9.1"], [null]])("keeps the Driver default for version %s", (version) => {
    const stateHome = makeStateHome();
    expect(prepareCuaCursorTheme(stateHome, version)).toBeNull();
    expect(FS.existsSync(cuaDriverCursorThemePath(stateHome))).toBe(false);
  });

  it("installs the compiled theme privately and returns its id", () => {
    const stateHome = makeStateHome();
    expect(prepareCuaCursorTheme(stateHome, "0.38.0")).toBe(CUA_CURSOR_THEME_ID);
    const target = cuaDriverCursorThemePath(stateHome);
    expect(FS.readFileSync(target).equals(artifact)).toBe(true);
    if (process.platform !== "win32") {
      expect(FS.statSync(target).mode & 0o777).toBe(0o600);
    }
    // Only the installed theme remains: no temporary files the Driver could list.
    expect(FS.readdirSync(Path.dirname(target))).toEqual([`${CUA_CURSOR_THEME_ID}.cua-theme`]);
  });

  it("leaves an identical installed theme untouched", () => {
    const stateHome = makeStateHome();
    prepareCuaCursorTheme(stateHome, "0.38.0");
    const target = cuaDriverCursorThemePath(stateHome);
    const before = FS.statSync(target);
    expect(prepareCuaCursorTheme(stateHome, "0.38.0")).toBe(CUA_CURSOR_THEME_ID);
    expect(FS.statSync(target).ino).toBe(before.ino);
  });

  it("replaces a stale theme and a symlinked one with the pinned artifact", () => {
    const stateHome = makeStateHome();
    const target = cuaDriverCursorThemePath(stateHome);
    FS.mkdirSync(Path.dirname(target), { recursive: true });
    FS.writeFileSync(target, "stale");
    expect(prepareCuaCursorTheme(stateHome, "0.38.0")).toBe(CUA_CURSOR_THEME_ID);
    expect(FS.readFileSync(target).equals(artifact)).toBe(true);

    if (process.platform === "win32") return;
    const elsewhere = Path.join(stateHome, "elsewhere.cua-theme");
    FS.writeFileSync(elsewhere, artifact);
    FS.rmSync(target);
    FS.symlinkSync(elsewhere, target);
    expect(prepareCuaCursorTheme(stateHome, "0.38.0")).toBe(CUA_CURSOR_THEME_ID);
    expect(FS.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(FS.readFileSync(target).equals(artifact)).toBe(true);
  });

  it("falls back to the Driver default instead of failing when the store is unwritable", () => {
    const stateHome = makeStateHome();
    // A file where the store directory belongs makes every write fail.
    FS.writeFileSync(Path.dirname(cuaDriverCursorThemePath(stateHome)), "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(prepareCuaCursorTheme(stateHome, "0.38.0")).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cursor theme unavailable"));
  });
});
