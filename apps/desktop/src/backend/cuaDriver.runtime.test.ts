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

const OTHER_VERSION = "0.39.0";
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
  it("selects a newer active generation ahead of the retained pinned release", () => {
    const base = baseDir();
    const active = generation(base, "a", { pointerVersion: OTHER_VERSION });
    const previous = generation(base, "p", { pointerVersion: CUA_DRIVER_VERSION });
    point(base, "activePath", active.pointer);
    point(base, "previousPath", previous.pointer);
    expect(resolveComputerUseRuntime(base)).toMatchObject({
      source: "managed",
      binaryPath: active.binaryPath,
      version: OTHER_VERSION,
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
    expect(resolveComputerUseRuntime(base)).toMatchObject({
      source: "managed",
      binaryPath: active.binaryPath,
      version: OTHER_VERSION,
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

  it("falls back to a newer previous generation when the active policy is invalid", () => {
    const base = baseDir();
    point(
      base,
      "activePath",
      generation(base, "a", { pointerVersion: OTHER_VERSION, policySha256: "invalid" }).pointer,
    );
    const previous = generation(base, "p", { manifestVersion: OTHER_VERSION });
    point(base, "previousPath", previous.pointer);
    expect(resolveComputerUseRuntime(base).binaryPath).toBe(previous.binaryPath);
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
