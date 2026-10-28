import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  activeRuntimePointer,
  cleanupUnreferencedVersions,
  retainedPreviousPointer,
  writeManagedPolicy,
} from "./cuaDriver.install";
import { resolveManagedPaths, resolveManagedVersionPaths } from "./cuaDriver.paths";
import { CUA_DRIVER_POLICY_YAML } from "@bigbud/shared/cua-driver/policy";
import { CUA_DRIVER_VERSION } from "@bigbud/shared/cua-driver/release";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

const pointer = (name: string, runtimeVersion?: string) => ({
  versionPath: `/v/${name}`,
  ...(runtimeVersion ? { runtimeVersion } : {}),
});

describe("managed Computer Use install recovery", () => {
  it("creates the versioned policy directory before writing the managed policy", () => {
    const baseDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "bigbud-cua-install-"));
    temporaryDirectories.push(baseDir);
    const versionPaths = resolveManagedVersionPaths(baseDir, "test");

    writeManagedPolicy(versionPaths.policyPath);

    expect(FS.readFileSync(versionPaths.policyPath, "utf8")).toBe(CUA_DRIVER_POLICY_YAML);
  });

  it("removes only unreferenced interrupted version directories", () => {
    const baseDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "bigbud-cua-install-"));
    temporaryDirectories.push(baseDir);
    const paths = resolveManagedPaths(baseDir);
    const active = Path.join(paths.versionsDir, "active");
    const previous = Path.join(paths.versionsDir, "previous");
    const interrupted = Path.join(paths.versionsDir, "interrupted");
    for (const directory of [active, previous, interrupted]) {
      FS.mkdirSync(directory, { recursive: true });
    }
    FS.writeFileSync(paths.activePath, JSON.stringify({ versionPath: active }));
    FS.writeFileSync(paths.previousPath, JSON.stringify({ versionPath: previous }));

    cleanupUnreferencedVersions(baseDir);

    expect(FS.existsSync(active)).toBe(true);
    expect(FS.existsSync(previous)).toBe(true);
    expect(FS.existsSync(interrupted)).toBe(false);
  });

  it("records the installed Driver version in the active pointer", () => {
    const versionPaths = resolveManagedVersionPaths("/base", "test");
    expect(activeRuntimePointer(versionPaths)).toMatchObject({
      versionPath: versionPaths.rootDir,
      binaryPath: versionPaths.binaryPath,
      runtimeVersion: CUA_DRIVER_VERSION,
    });
  });

  it("keeps one retained generation per known version when reinstalling the pinned version", () => {
    const other = CUA_DRIVER_VERSION === "0.9.1" ? "0.38.0" : "0.9.1";
    // First install of the pin over the other version: previous := the other version.
    expect(
      retainedPreviousPointer({
        active: pointer("old", other),
        previous: null,
        installingVersion: CUA_DRIVER_VERSION,
      }),
    ).toEqual(pointer("old", other));
    // Repair or reinstall of the pin: the other version's rollback slot is kept.
    expect(
      retainedPreviousPointer({
        active: pointer("pin-a", CUA_DRIVER_VERSION),
        previous: pointer("old", other),
        installingVersion: CUA_DRIVER_VERSION,
      }),
    ).toBeNull();
    // Both already the pin, or the previous version unknown: last active, as before.
    expect(
      retainedPreviousPointer({
        active: pointer("pin-a", CUA_DRIVER_VERSION),
        previous: pointer("pin-b", CUA_DRIVER_VERSION),
        installingVersion: CUA_DRIVER_VERSION,
      }),
    ).toEqual(pointer("pin-a", CUA_DRIVER_VERSION));
    expect(
      retainedPreviousPointer({
        active: pointer("pin-a", CUA_DRIVER_VERSION),
        previous: pointer("unknown"),
        installingVersion: CUA_DRIVER_VERSION,
      }),
    ).toEqual(pointer("pin-a", CUA_DRIVER_VERSION));
    expect(
      retainedPreviousPointer({ active: null, previous: null, installingVersion: "x" }),
    ).toBeNull();
  });
});
