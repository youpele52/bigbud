import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SERVER_NATIVE_TARGET_ARCH_ENV,
  nativeReleaseBuildPlan,
  requireNativeBuildOutput,
  resolveServerNativeTarget,
} from "./native-release-build.ts";
import { findWorkspaceAgentTarget } from "./workspace-agent-target.ts";

describe("resolveServerNativeTarget", () => {
  it("builds for the host when the target architecture is unset", () => {
    const resolved = resolveServerNativeTarget({}, "darwin", "arm64");
    expect(resolved.native).toBe(true);
    expect(resolved.target.rustTarget).toBe("aarch64-apple-darwin");
  });

  it("treats a requested host architecture as a native build", () => {
    const resolved = resolveServerNativeTarget(
      { [SERVER_NATIVE_TARGET_ARCH_ENV]: "arm64" },
      "darwin",
      "arm64",
    );
    expect(resolved.native).toBe(true);
  });

  it("skips the host architecture and targets x64 on an Apple Silicon cross build", () => {
    const resolved = resolveServerNativeTarget(
      { [SERVER_NATIVE_TARGET_ARCH_ENV]: " x64 " },
      "darwin",
      "arm64",
    );
    expect(resolved.native).toBe(false);
    expect(resolved.target).toMatchObject({ platform: "darwin", arch: "x64" });
    expect(resolved.target.rustTarget).toBe("x86_64-apple-darwin");
  });

  it("rejects unknown architectures instead of falling back to the host", () => {
    expect(() =>
      resolveServerNativeTarget(
        { [SERVER_NATIVE_TARGET_ARCH_ENV]: "universal" },
        "darwin",
        "arm64",
      ),
    ).toThrow(`${SERVER_NATIVE_TARGET_ARCH_ENV} must be arm64 or x64`);
  });

  it("rejects hosts without a native helper target", () => {
    expect(() => resolveServerNativeTarget({}, "freebsd", "x64")).toThrow(
      "Unsupported server native target: freebsd/x64",
    );
  });
});

describe("nativeReleaseBuildPlan", () => {
  const x64 = findWorkspaceAgentTarget("darwin", "x64")!;

  it("uses the default target directory for native builds", () => {
    expect(
      nativeReleaseBuildPlan({
        repoRoot: "/repo",
        packageName: "bigbud-remote-agent",
        binaryName: "bigbud-remote-agent",
        target: x64,
        native: true,
      }),
    ).toEqual({
      cargoArgs: ["build", "--locked", "--release", "--package", "bigbud-remote-agent"],
      source: "/repo/target/release/bigbud-remote-agent",
    });
  });

  it("passes --target and reads the triple directory for cross builds", () => {
    expect(
      nativeReleaseBuildPlan({
        repoRoot: "/repo",
        packageName: "bigbud-desktop-supervisor",
        binaryName: "bigbud-desktop-supervisor",
        target: x64,
        native: false,
      }),
    ).toEqual({
      cargoArgs: [
        "build",
        "--locked",
        "--release",
        "--package",
        "bigbud-desktop-supervisor",
        "--target",
        "x86_64-apple-darwin",
      ],
      source: "/repo/target/x86_64-apple-darwin/release/bigbud-desktop-supervisor",
    });
  });
});

describe("requireNativeBuildOutput", () => {
  it("fails loudly when the target binary is missing and passes once it exists", () => {
    const directory = mkdtempSync(join(tmpdir(), "native-release-build-"));
    try {
      const binary = join(directory, "bigbud-remote-agent");
      expect(() => requireNativeBuildOutput(binary, "Workspace watcher agent")).toThrow(
        `Workspace watcher agent is missing after the cargo build: expected ${binary}`,
      );
      writeFileSync(binary, "");
      expect(() => requireNativeBuildOutput(binary, "Workspace watcher agent")).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
