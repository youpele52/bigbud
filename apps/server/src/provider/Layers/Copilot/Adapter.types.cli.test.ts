import { describe, expect, it } from "vitest";

import { copilotNativePackageName, resolveCopilotRuntimeInvocation } from "./Adapter.types.cli.ts";

describe("CopilotAdapter.types.cli", () => {
  it.each([
    [{ platform: "darwin", arch: "arm64", isMusl: false }, "@github/copilot-darwin-arm64"],
    [{ platform: "darwin", arch: "x64", isMusl: false }, "@github/copilot-darwin-x64"],
    [{ platform: "win32", arch: "arm64", isMusl: false }, "@github/copilot-win32-arm64"],
    [{ platform: "win32", arch: "x64", isMusl: false }, "@github/copilot-win32-x64"],
    [{ platform: "linux", arch: "arm64", isMusl: false }, "@github/copilot-linux-arm64"],
    [{ platform: "linux", arch: "x64", isMusl: false }, "@github/copilot-linux-x64"],
    [{ platform: "linux", arch: "arm64", isMusl: true }, "@github/copilot-linuxmusl-arm64"],
    [{ platform: "linux", arch: "x64", isMusl: true }, "@github/copilot-linuxmusl-x64"],
  ] as const)("selects %s", (input, expected) => {
    expect(copilotNativePackageName(input)).toBe(expected);
  });

  it("prefers a configured executable", () => {
    expect(resolveCopilotRuntimeInvocation("/usr/local/bin/copilot")).toEqual({
      path: "/usr/local/bin/copilot",
      args: [],
      source: "configured",
    });
  });

  it("uses the platform-native runtime in Electron", () => {
    expect(
      resolveCopilotRuntimeInvocation("copilot", {
        isElectron: true,
        platform: "darwin",
        arch: "arm64",
        isMusl: false,
        resolve: (id) => `/runtime/${id}/copilot`,
      }),
    ).toEqual({
      path: "/runtime/@github/copilot-darwin-arm64/copilot",
      args: [],
      source: "bundled-native",
    });
  });

  it("does not fall back to the SDK JavaScript launcher when the native runtime is missing", () => {
    expect(() =>
      resolveCopilotRuntimeInvocation("copilot", {
        isElectron: true,
        platform: "darwin",
        arch: "arm64",
        isMusl: false,
        resolve: () => {
          throw new Error("missing package");
        },
      }),
    ).toThrow("Unable to resolve the bundled Copilot runtime package @github/copilot-darwin-arm64");
  });

  it("reports unsupported Electron platforms explicitly", () => {
    expect(() =>
      resolveCopilotRuntimeInvocation("copilot", {
        isElectron: true,
        platform: "freebsd",
        arch: "x64",
        isMusl: false,
      }),
    ).toThrow("No bundled Copilot runtime is available for freebsd/x64");
  });

  it("lets the SDK resolve its bundled runtime outside Electron", () => {
    expect(resolveCopilotRuntimeInvocation("copilot", { isElectron: false })).toBeUndefined();
  });
});
