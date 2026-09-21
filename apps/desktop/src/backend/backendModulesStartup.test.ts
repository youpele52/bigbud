import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const windows: never[] = [];
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => windows } }));

import {
  ensureBackendModulesPathForOptions,
  reportBackendModulesStartupFailure,
} from "./backendModulesStartup";
import { getBackendStartupState } from "./backendStartupState";

function makeServerDir(): string {
  const root = mkdtempSync(join(tmpdir(), "backend-modules-startup-"));
  const serverDir = join(root, "server");
  mkdirSync(serverDir);
  return serverDir;
}

function cleanup(serverDir: string): void {
  rmSync(join(serverDir, ".."), { recursive: true, force: true });
}

function packagedOptions(serverDir: string, platform: string) {
  return {
    isPackaged: true,
    platform,
    resourcesPath: join(serverDir, ".."),
  } as const;
}

describe("backendModulesStartup", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("does nothing for an unpackaged development runtime", () => {
    const serverDir = makeServerDir();
    try {
      expect(
        ensureBackendModulesPathForOptions({
          isPackaged: false,
          platform: "darwin",
          resourcesPath: join(serverDir, ".."),
        }),
      ).toBeNull();
      expect(() => lstatSync(join(serverDir, "node_modules"))).toThrow();
    } finally {
      cleanup(serverDir);
    }
  });

  it("accepts a valid packaged macOS link", () => {
    const serverDir = makeServerDir();
    try {
      mkdirSync(join(serverDir, "_modules"));
      symlinkSync("_modules", join(serverDir, "node_modules"), "dir");
      expect(ensureBackendModulesPathForOptions(packagedOptions(serverDir, "darwin"))).toBeNull();
    } finally {
      cleanup(serverDir);
    }
  });

  it.each(["missing-link", "wrong-target", "regular-directory", "regular-file"])(
    "rejects an invalid macOS package without mutating %s",
    (variant) => {
      const serverDir = makeServerDir();
      try {
        mkdirSync(join(serverDir, "_modules"));
        const nodeModulesPath = join(serverDir, "node_modules");
        if (variant === "wrong-target") {
          mkdirSync(join(serverDir, "other-modules"));
          symlinkSync("other-modules", nodeModulesPath, "dir");
        } else if (variant === "regular-directory") {
          mkdirSync(nodeModulesPath);
          writeFileSync(join(nodeModulesPath, "marker"), "keep");
        } else if (variant === "regular-file") {
          writeFileSync(nodeModulesPath, "keep");
        }

        const result = ensureBackendModulesPathForOptions(packagedOptions(serverDir, "darwin"));
        expect(result?.reason).toBe("backend_modules_invalid");
        if (variant === "missing-link") {
          expect(() => lstatSync(nodeModulesPath)).toThrow();
        } else if (variant === "wrong-target") {
          expect(readlinkSync(nodeModulesPath)).toBe("other-modules");
        } else if (variant === "regular-directory") {
          expect(lstatSync(nodeModulesPath).isDirectory()).toBe(true);
          expect(() => lstatSync(join(nodeModulesPath, "marker"))).not.toThrow();
        } else {
          expect(lstatSync(nodeModulesPath).isFile()).toBe(true);
        }
      } finally {
        cleanup(serverDir);
      }
    },
  );

  it("rejects missing packaged macOS _modules without creating anything", () => {
    const serverDir = makeServerDir();
    try {
      const result = ensureBackendModulesPathForOptions(packagedOptions(serverDir, "darwin"));
      expect(result?.reason).toBe("backend_modules_invalid");
      expect(() => lstatSync(join(serverDir, "_modules"))).toThrow();
      expect(() => lstatSync(join(serverDir, "node_modules"))).toThrow();
    } finally {
      cleanup(serverDir);
    }
  });

  it("preserves Linux creation and replacement behavior", () => {
    const serverDir = makeServerDir();
    try {
      const modulesDir = join(serverDir, "_modules");
      const nodeModulesPath = join(serverDir, "node_modules");
      mkdirSync(modulesDir);
      expect(ensureBackendModulesPathForOptions(packagedOptions(serverDir, "linux"))).toBeNull();
      expect(readlinkSync(nodeModulesPath)).toBe("_modules");
      rmSync(nodeModulesPath, { recursive: true });
      mkdirSync(nodeModulesPath);
      ensureBackendModulesPathForOptions(packagedOptions(serverDir, "linux"));
      expect(readlinkSync(nodeModulesPath)).toBe("_modules");
    } finally {
      cleanup(serverDir);
    }
  });

  it("keeps Windows junction-first behavior usable in the test runtime", () => {
    const serverDir = makeServerDir();
    try {
      mkdirSync(join(serverDir, "_modules"));
      expect(ensureBackendModulesPathForOptions(packagedOptions(serverDir, "win32"))).toBeNull();
      const stat = lstatSync(join(serverDir, "node_modules"));
      expect(stat.isSymbolicLink() || stat.isDirectory()).toBe(true);
    } finally {
      cleanup(serverDir);
    }
  });

  it("records one bounded backend_modules_invalid startup failure", () => {
    const log = vi.fn();
    const failure = {
      reason: "backend_modules_invalid",
      message: "Packaged macOS backend modules are missing or invalid.",
    } as const;
    reportBackendModulesStartupFailure(failure, log);
    const generation = getBackendStartupState().generation;
    reportBackendModulesStartupFailure(failure, log);
    expect(getBackendStartupState()).toMatchObject({
      failureReason: "backend_modules_invalid",
      generation,
      status: "failed",
    });
    expect(getBackendStartupState().generation).toBe(generation);
    expect(log).toHaveBeenCalledOnce();
  });
});
