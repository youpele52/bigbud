import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CUA_DRIVER_POLICY_SHA256,
  CUA_DRIVER_POLICY_VERSION,
} from "@bigbud/shared/cua-driver/policy";
import { CUA_DRIVER_VERSION } from "@bigbud/shared/cua-driver/release";

vi.mock("electron", () => ({ app: { isPackaged: false } }));

import { writeManagedPolicy } from "./cuaDriver.install";
import { resolveManagedPaths, resolveManagedVersionPaths } from "./cuaDriver.paths";
import { readPointerRuntimeVersion, resolveComputerUseRuntime } from "./cuaDriver.runtime";

const OTHER_VERSION = CUA_DRIVER_VERSION === "0.9.1" ? "0.38.0" : "0.9.1";
const directories: string[] = [];
let savedPath: string | undefined;

function baseDir(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "bigbud-cua-runtime-"));
  directories.push(directory);
  return directory;
}

/** A complete generation; `runtimeVersion` on the pointer and/or in its manifest. */
function generation(
  base: string,
  name: string,
  options: { pointerVersion?: string; manifestVersion?: string; policySha256?: string } = {},
) {
  const paths = resolveManagedVersionPaths(base, name);
  FS.mkdirSync(Path.dirname(paths.binaryPath), { recursive: true });
  FS.writeFileSync(paths.binaryPath, "binary");
  writeManagedPolicy(paths.policyPath);
  if (options.manifestVersion) {
    FS.writeFileSync(
      paths.installManifestPath,
      JSON.stringify({ runtimeVersion: options.manifestVersion }),
    );
  }
  return {
    binaryPath: paths.binaryPath,
    pointer: {
      versionPath: paths.rootDir,
      binaryPath: paths.binaryPath,
      policyPath: paths.policyPath,
      policyVersion: CUA_DRIVER_POLICY_VERSION,
      policySha256: options.policySha256 ?? CUA_DRIVER_POLICY_SHA256,
      ...(options.pointerVersion ? { runtimeVersion: options.pointerVersion } : {}),
    },
  };
}

function point(base: string, which: "activePath" | "previousPath", pointer: object): void {
  const target = resolveManagedPaths(base)[which];
  FS.mkdirSync(Path.dirname(target), { recursive: true });
  FS.writeFileSync(target, JSON.stringify(pointer));
}

beforeEach(() => {
  // No system cua-driver from the developer's PATH may be selected.
  savedPath = process.env.PATH;
  process.env.PATH = "";
});

afterEach(() => {
  process.env.PATH = savedPath;
  for (const directory of directories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("version-aware runtime selection", () => {
  it("skips an active generation of another Driver version and uses the retained previous one", () => {
    const base = baseDir();
    const active = generation(base, "a", { pointerVersion: OTHER_VERSION });
    const previous = generation(base, "p", { pointerVersion: CUA_DRIVER_VERSION });
    point(base, "activePath", active.pointer);
    point(base, "previousPath", previous.pointer);
    expect(resolveComputerUseRuntime(base)).toMatchObject({
      source: "managed",
      binaryPath: previous.binaryPath,
      version: CUA_DRIVER_VERSION,
    });
  });

  it("keeps an active generation of the pinned version over the previous one", () => {
    const base = baseDir();
    const active = generation(base, "a", { pointerVersion: CUA_DRIVER_VERSION });
    const previous = generation(base, "p", { pointerVersion: OTHER_VERSION });
    point(base, "activePath", active.pointer);
    point(base, "previousPath", previous.pointer);
    expect(resolveComputerUseRuntime(base).binaryPath).toBe(active.binaryPath);
  });

  it("reads the version from the install manifest of older pointers", () => {
    const base = baseDir();
    const active = generation(base, "a", { manifestVersion: OTHER_VERSION });
    point(base, "activePath", active.pointer);
    expect(readPointerRuntimeVersion(active.pointer)).toBe(OTHER_VERSION);
    expect(resolveComputerUseRuntime(base)).toEqual({
      source: "missing",
      binaryPath: null,
      policyPath: null,
      version: null,
    });
  });

  it("accepts a pointer whose version is unknown, as before", () => {
    const base = baseDir();
    const active = generation(base, "a");
    point(base, "activePath", active.pointer);
    expect(readPointerRuntimeVersion(active.pointer)).toBeNull();
    expect(resolveComputerUseRuntime(base)).toMatchObject({
      binaryPath: active.binaryPath,
      version: null,
    });
  });

  it("falls through to missing when both generations are another version", () => {
    const base = baseDir();
    point(base, "activePath", generation(base, "a", { pointerVersion: OTHER_VERSION }).pointer);
    point(base, "previousPath", generation(base, "p", { manifestVersion: OTHER_VERSION }).pointer);
    expect(resolveComputerUseRuntime(base).source).toBe("missing");
  });

  it("still enforces the policy digest for a matching version", () => {
    const base = baseDir();
    const active = generation(base, "a", {
      pointerVersion: CUA_DRIVER_VERSION,
      policySha256: "0".repeat(64),
    });
    point(base, "activePath", active.pointer);
    expect(resolveComputerUseRuntime(base).source).toBe("missing");
  });
});
