import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  COPILOT_RUNTIME_SDK_VERSION,
  COPILOT_RUNTIME_VERSION,
  resolveCopilotRuntimeRelease,
} from "./Runtime.release.ts";

describe("pinned Copilot runtime release", () => {
  it.each([
    ["darwin", "arm64", false, 120249222, 181811714],
    ["darwin", "x64", false, 126834367, 190246566],
    ["linux", "arm64", false, 131317972, 194517689],
    ["linux", "x64", false, 130078031, 198449901],
    ["linux", "arm64", true, 121925970, 189405196],
    ["linux", "x64", true, 125442864, 197262464],
    ["win32", "arm64", false, 113492663, 164708552],
    ["win32", "x64", false, 113485450, 172572860],
  ] as const)("pins %s/%s musl=%s", (platform, arch, isMusl, archiveBytes, unpackedBytes) => {
    const release = resolveCopilotRuntimeRelease({ platform, arch, isMusl });
    expect(release.version).toBe(COPILOT_RUNTIME_VERSION);
    expect(release.archiveBytes).toBe(archiveBytes);
    expect(release.unpackedBytes).toBe(unpackedBytes);
    expect(release.archiveBytes).toBeLessThan(release.unpackedBytes);
    expect(release.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    expect(release.url).toBe(
      `https://registry.npmjs.org/${release.packageName}/-/copilot-${release.target}-${release.version}.tgz`,
    );
    expect(release.binaryName).toBe(platform === "win32" ? "copilot.exe" : "copilot");
  });

  it.each([
    ["freebsd", "x64"],
    ["linux", "ia32"],
    ["darwin", "universal"],
  ] as const)("rejects unsupported %s/%s", (platform, arch) => {
    expect(() => resolveCopilotRuntimeRelease({ platform, arch, isMusl: false })).toThrow(
      "No Copilot runtime release",
    );
  });

  it("matches the installed SDK's declared compatible CLI version", () => {
    const require = createRequire(import.meta.url);
    const sdkRoot = Path.resolve(Path.dirname(require.resolve("@github/copilot-sdk")), "../..");
    const sdk = JSON.parse(readFileSync(Path.join(sdkRoot, "package.json"), "utf8"));
    expect(sdk.version).toBe(COPILOT_RUNTIME_SDK_VERSION);
    expect(sdk.copilotCliVersion).toBe(COPILOT_RUNTIME_VERSION);
    const server = JSON.parse(
      readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
    );
    expect(server.dependencies["@github/copilot-sdk"]).toBe(COPILOT_RUNTIME_SDK_VERSION);
    expect(server.dependencies["@github/copilot"]).toBe(COPILOT_RUNTIME_VERSION);
  });
});
