import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { resolveCommandPath } from "./commandPath.ts";

const dir = mkdtempSync(join(tmpdir(), "command-path-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("resolveCommandPath", () => {
  it("resolves a bare Windows name through PATHEXT to a .cmd launcher", () => {
    writeFileSync(join(dir, "muse.CMD"), "@echo off\r\n");
    const env = { PATH: `C:\\missing;${dir}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    expect(resolveCommandPath("muse", { platform: "win32", env })).toBe(join(dir, "muse.CMD"));
  });

  it("returns null when nothing on PATH matches", () => {
    expect(resolveCommandPath("absent", { platform: "win32", env: { PATH: dir } })).toBeNull();
    expect(resolveCommandPath("absent", { platform: "linux", env: { PATH: "" } })).toBeNull();
  });

  it("requires the executable bit on POSIX and checks explicit paths directly", () => {
    const tool = join(dir, "tool");
    writeFileSync(tool, "#!/bin/sh\n");
    chmodSync(tool, 0o644);
    expect(resolveCommandPath("tool", { platform: "linux", env: { PATH: dir } })).toBeNull();
    chmodSync(tool, 0o755);
    expect(resolveCommandPath("tool", { platform: "linux", env: { PATH: dir } })).toBe(tool);
    expect(resolveCommandPath(tool, { platform: "linux", env: {} })).toBe(tool);
  });
});
