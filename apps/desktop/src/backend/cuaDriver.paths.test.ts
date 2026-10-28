import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveManagedPaths, resolveManagedVersionPaths } from "./cuaDriver.paths";

// `cuaDriverBaseDir` from the main config: the base dir when packaged, `<base>/dev` in development.
const PACKAGED_BASE = "/home/user/.bigbud";
const DEV_BASE = "/home/user/.bigbud/dev";

describe("resolveManagedPaths", () => {
  it("keeps the packaged runtime layout exactly as before", () => {
    const managed = resolveManagedPaths(PACKAGED_BASE);
    expect(managed.rootDir).toBe("/home/user/.bigbud/runtime/cua-driver");
    expect(managed.activePath).toBe("/home/user/.bigbud/runtime/cua-driver/active.json");
    expect(managed.previousPath).toBe("/home/user/.bigbud/runtime/cua-driver/previous.json");
    expect(managed.versionsDir).toBe("/home/user/.bigbud/runtime/cua-driver/versions");
  });

  it("puts every development runtime path outside the installed app's runtime root", () => {
    const installedRoot = resolveManagedPaths(PACKAGED_BASE).rootDir;
    const dev = resolveManagedPaths(DEV_BASE);
    const devVersion = resolveManagedVersionPaths(DEV_BASE);
    expect(dev.rootDir).toBe("/home/user/.bigbud/dev/runtime/cua-driver");
    const devPaths = [...Object.values(dev), ...Object.values(devVersion)];
    for (const path of devPaths) {
      const relative = Path.relative(installedRoot, path);
      const insideInstalledRoot = relative === "" || !relative.startsWith("..");
      expect(insideInstalledRoot, path).toBe(false);
    }
  });

  it("resolves one private Driver state home per base dir, inside the runtime root", () => {
    const dev = resolveManagedPaths(DEV_BASE);
    const packaged = resolveManagedPaths(PACKAGED_BASE);
    expect(dev.homeDir).toBe("/home/user/.bigbud/dev/runtime/cua-driver/home");
    expect(packaged.homeDir).toBe("/home/user/.bigbud/runtime/cua-driver/home");
    expect(dev.homeDir).not.toBe(packaged.homeDir);
    for (const managed of [dev, packaged]) {
      expect(Path.relative(managed.rootDir, managed.homeDir)).toBe("home");
    }
  });
});
