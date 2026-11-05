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
    ["darwin", "arm64", false, 120320932, 181877378],
    ["darwin", "x64", false, 126913270, 190324998],
    ["linux", "arm64", false, 131398559, 194648761],
    ["linux", "x64", false, 130166621, 198515437],
    ["linux", "arm64", true, 122004723, 189482156],
    ["linux", "x64", true, 125523042, 197344976],
    ["win32", "arm64", false, 113575126, 164790472],
    ["win32", "x64", false, 113558624, 172641980],
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
