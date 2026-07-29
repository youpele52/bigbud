import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupUnreferencedVersions, writeManagedPolicy } from "./cuaDriver.install";
import { resolveManagedPaths, resolveManagedVersionPaths } from "./cuaDriver.paths";
import { CUA_DRIVER_POLICY_YAML } from "@bigbud/shared/cua-driver/policy";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
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
});
