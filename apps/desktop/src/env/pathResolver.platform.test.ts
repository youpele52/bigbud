import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveBackendModulesLinkPlan,
  resolvePackagedOpencodeBinaryPlan,
} from "./pathResolver.platform";

describe("resolveBackendModulesLinkPlan", () => {
  const resourcesPath = "/Applications/bigbud.app/Contents/Resources";

  describe("Windows (win32)", () => {
    it("returns junction link type", () => {
      const plan = resolveBackendModulesLinkPlan("win32", resourcesPath);
      expect(plan.linkType).toBe("junction");
    });

    it("uses absolute modulesDir as linkTarget", () => {
      const plan = resolveBackendModulesLinkPlan("win32", resourcesPath);
      expect(Path.isAbsolute(plan.linkTarget)).toBe(true);
      expect(plan.linkTarget).toBe(plan.modulesDir);
    });

    it("computes correct paths from resourcesPath", () => {
      const plan = resolveBackendModulesLinkPlan("win32", resourcesPath);
      expect(plan.serverDir).toBe(Path.join(resourcesPath, "server"));
      expect(plan.modulesDir).toBe(Path.join(resourcesPath, "server", "_modules"));
      expect(plan.nodeModulesPath).toBe(Path.join(resourcesPath, "server", "node_modules"));
    });
  });

  describe("macOS (darwin)", () => {
    it("returns dir link type", () => {
      const plan = resolveBackendModulesLinkPlan("darwin", resourcesPath);
      expect(plan.linkType).toBe("dir");
    });

    it("uses relative _modules as linkTarget", () => {
      const plan = resolveBackendModulesLinkPlan("darwin", resourcesPath);
      expect(plan.linkTarget).toBe("_modules");
      expect(Path.isAbsolute(plan.linkTarget)).toBe(false);
    });

    it("computes correct paths from resourcesPath", () => {
      const plan = resolveBackendModulesLinkPlan("darwin", resourcesPath);
      expect(plan.serverDir).toBe(Path.join(resourcesPath, "server"));
      expect(plan.modulesDir).toBe(Path.join(resourcesPath, "server", "_modules"));
      expect(plan.nodeModulesPath).toBe(Path.join(resourcesPath, "server", "node_modules"));
    });
  });

  describe("Linux (linux)", () => {
    it("returns dir link type", () => {
      const plan = resolveBackendModulesLinkPlan("linux", resourcesPath);
      expect(plan.linkType).toBe("dir");
    });

    it("uses relative _modules as linkTarget", () => {
      const plan = resolveBackendModulesLinkPlan("linux", resourcesPath);
      expect(plan.linkTarget).toBe("_modules");
      expect(Path.isAbsolute(plan.linkTarget)).toBe(false);
    });

    it("computes correct paths from resourcesPath", () => {
      const plan = resolveBackendModulesLinkPlan("linux", resourcesPath);
      expect(plan.serverDir).toBe(Path.join(resourcesPath, "server"));
      expect(plan.modulesDir).toBe(Path.join(resourcesPath, "server", "_modules"));
      expect(plan.nodeModulesPath).toBe(Path.join(resourcesPath, "server", "node_modules"));
    });
  });

  describe("Windows with Windows-style paths", () => {
    const winResourcesPath = "C:\\Program Files\\bigbud\\resources";

    it("produces absolute Windows junction target", () => {
      const plan = resolveBackendModulesLinkPlan("win32", winResourcesPath);
      expect(plan.linkType).toBe("junction");
      expect(plan.linkTarget).toBe(plan.modulesDir);
      expect(plan.modulesDir).toBe(Path.join(winResourcesPath, "server", "_modules"));
    });
  });
});

describe("resolvePackagedOpencodeBinaryPlan", () => {
  const resourcesPath = "/Applications/bigbud.app/Contents/Resources";

  it("uses opencode.exe on Windows", () => {
    const plan = resolvePackagedOpencodeBinaryPlan("win32", resourcesPath);
    expect(plan.serverDir).toBe(Path.join(resourcesPath, "server"));
    expect(plan.opencodeDir).toBe(Path.join(resourcesPath, "server", "opencode"));
    expect(plan.binDir).toBe(Path.join(resourcesPath, "server", "opencode", "bin"));
    expect(plan.binaryName).toBe("opencode.exe");
    expect(plan.binaryPath).toBe(
      Path.join(resourcesPath, "server", "opencode", "bin", "opencode.exe"),
    );
  });

  it("uses opencode on POSIX", () => {
    const plan = resolvePackagedOpencodeBinaryPlan("darwin", resourcesPath);
    expect(plan.binaryName).toBe("opencode");
    expect(plan.binaryPath).toBe(Path.join(resourcesPath, "server", "opencode", "bin", "opencode"));
  });
});
