import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  releasePackageFiles,
  updateReleasePackageVersions,
} from "./update-release-package-versions.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("release package identity", () => {
  it.each(["v0.3.00", "v0.3.0", "0.3.0"])("persists exact source identity for %s", (tag) => {
    const rootDir = mkdtempSync(join(tmpdir(), "bigbud-release-package-"));
    directories.push(rootDir);
    for (const file of releasePackageFiles) {
      const path = join(rootDir, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ name: file, version: "0.2.0" }));
    }
    execFileSync(process.execPath, [
      fileURLToPath(new URL("./update-release-package-versions.ts", import.meta.url)),
      tag,
      "--root",
      rootDir,
    ]);
    for (const file of releasePackageFiles) {
      const metadata = JSON.parse(readFileSync(join(rootDir, file), "utf8"));
      expect(metadata.version).toBe("0.3.0");
      if (file === "apps/server/package.json")
        expect(metadata.bigbudReleaseTag).toBe(tag.startsWith("v") ? tag : `v${tag}`);
    }
    expect(updateReleasePackageVersions(tag, { rootDir })).toEqual({ changed: false });
    expect(updateReleasePackageVersions("v0.3.00", { rootDir })).toEqual({
      changed: tag !== "v0.3.00",
    });
  });
});
