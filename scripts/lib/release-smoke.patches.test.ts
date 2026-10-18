import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { copyReleaseSmokePatches } from "./release-smoke.patches";

describe("release smoke patch staging", () => {
  let root: string;
  let source: string;
  let target: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bigbud-smoke-patches-"));
    source = join(root, "source");
    target = join(root, "target");
    mkdirSync(source);
    mkdirSync(target);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function manifest(patchedDependencies?: unknown): void {
    writeFileSync(join(source, "package.json"), JSON.stringify({ patchedDependencies }));
  }

  it("copies every declared patch, including custom directories and shared files", () => {
    const patches = {
      "effect@4.0.0-beta.43": "patches/effect@4.0.0-beta.43.patch",
      "other@1": "custom/nested/other.patch",
      "other@2": "custom/nested/other.patch",
    };
    manifest(patches);
    for (const path of Object.values(patches)) {
      mkdirSync(dirname(join(source, path)), { recursive: true });
      writeFileSync(join(source, path), `patch content: ${path}`);
    }
    copyReleaseSmokePatches(source, target);
    for (const path of Object.values(patches)) {
      expect(readFileSync(join(target, path), "utf8")).toBe(`patch content: ${path}`);
    }
  });

  it("supports manifests without patched dependencies", () => {
    manifest();
    expect(() => copyReleaseSmokePatches(source, target)).not.toThrow();
  });

  it.each([null, [], "patches/file.patch"])("rejects invalid mappings: %j", (value) => {
    manifest(value);
    expect(() => copyReleaseSmokePatches(source, target)).toThrow("package-to-path mapping");
  });

  it.each([
    "../escape.patch",
    "/absolute.patch",
    "C:/drive.patch",
    "C:drive.patch",
    "..\\escape.patch",
    "",
    "\0",
    7,
  ])("rejects unsafe patch paths: %j", (path) => {
    manifest({ "package@1": path });
    expect(() => copyReleaseSmokePatches(source, target)).toThrow("repository-relative");
  });

  it("fails early when a declared patch is missing", () => {
    manifest({ "package@1": "patches/missing.patch" });
    expect(() => copyReleaseSmokePatches(source, target)).toThrow("ENOENT");
  });

  it.skipIf(process.platform === "win32")("rejects symlinks outside the repository", () => {
    writeFileSync(join(root, "outside.patch"), "outside");
    symlinkSync(join(root, "outside.patch"), join(source, "linked.patch"));
    manifest({ "package@1": "linked.patch" });
    expect(() => copyReleaseSmokePatches(source, target)).toThrow("escapes the repository");
  });
});
