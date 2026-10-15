import { expect, it } from "vitest";
import {
  resolveV2NativeReleaseQualification,
  selectV2NativeReleaseEvidence,
  validateV2NativeQualificationRegistry,
} from "./NativeCompatibility.qualification.ts";
import { syntheticV2QualificationRecord } from "./NativeCompatibility.qualification.fixture.ts";
import { v2NativeRuntimePlatform } from "./NativeCompatibility.platform.ts";
import {
  selectV2NativeConfigProfile,
  validateV2NativeConfigSources,
} from "./NativeCompatibility.sources.ts";
import type { OpencodeV2Client } from "./Client.ts";

it.each(["darwin", "linux", "win32"])(
  "%s ARM64/x64 is a candidate, not an invented qualification",
  (platform) => {
    for (const arch of ["arm64", "x64"]) {
      expect(v2NativeRuntimePlatform(platform, arch)).toEqual({ platform, arch });
      expect(resolveV2NativeReleaseQualification("2.0.29", platform, arch)).toBeUndefined();
      for (const version of ["1.0.0", "3.0.0", "2.0.29-beta", "2.0.29+local", "02.0.29"])
        expect(() => resolveV2NativeReleaseQualification(version, platform, arch)).toThrow();
    }
  },
);

it("qualifications and semantic denies are scoped to the exact release/platform/architecture", () => {
  const mac = syntheticV2QualificationRecord();
  const linux = { ...mac, platform: "linux", arch: "x64" };
  const registry = validateV2NativeQualificationRegistry(
    [mac, linux],
    [
      {
        format: "bigbud.thread.native-incompatible.v1",
        nativeVersion: mac.nativeVersion,
        platform: "win32",
        arch: "x64",
        nativeContractDigest: mac.nativeContractDigest,
        scope: "native-tool-schema-catalog-permissions",
        reason: "synthetic failure",
        resultsDigest: mac.resultsDigest,
      },
    ],
  );
  expect(
    selectV2NativeReleaseEvidence(registry, mac.nativeVersion, "darwin", "arm64")?.record.platform,
  ).toBe("darwin");
  expect(
    selectV2NativeReleaseEvidence(registry, mac.nativeVersion, "linux", "x64")?.record.platform,
  ).toBe("linux");
  expect(
    selectV2NativeReleaseEvidence(registry, mac.nativeVersion, "darwin", "x64"),
  ).toBeUndefined();
  expect(
    selectV2NativeReleaseEvidence(registry, mac.nativeVersion, "win32", "arm64"),
  ).toBeUndefined();
  expect(() => selectV2NativeReleaseEvidence(registry, mac.nativeVersion, "win32", "x64")).toThrow(
    "incompatibility",
  );
  expect(() => v2NativeRuntimePlatform("freebsd", "x64")).toThrow();
  expect(() => v2NativeRuntimePlatform("linux", "ia32")).toThrow();
});

it.each([
  {
    platform: "darwin" as const,
    root: "/Users/test/.config/opencode",
    system: "/Library/Application Support/opencode",
    sep: "/",
  },
  {
    platform: "linux" as const,
    root: "/home/test/.config/opencode",
    system: "/etc/opencode",
    sep: "/",
  },
  {
    platform: "win32" as const,
    root: "C:\\Users\\test\\.config\\opencode",
    system: "C:\\ProgramData\\opencode",
    sep: "\\",
  },
])("$platform uses its machine namespace and never makes it the publication root", (spec) => {
  const options = { platform: spec.platform, programData: "C:\\ProgramData" };
  const entries = [
    { type: "directory", path: spec.system },
    {
      type: "document",
      path: `${spec.system}${spec.sep}opencode.json`,
      info: { plugins: ["-bigbud.thread.v1"] },
    },
    { type: "document", path: `${spec.root}${spec.sep}opencode.json`, info: {} },
    { type: "directory", path: spec.root },
  ] as Awaited<ReturnType<OpencodeV2Client["config"]["get"]>>;
  expect(selectV2NativeConfigProfile(entries, spec.root, options)).toBe(
    "v2-system-global-config-v1",
  );
  expect([
    ...validateV2NativeConfigSources(entries, spec.root, "v2-system-global-config-v1", options),
  ]).toEqual([`${spec.system}${spec.sep}opencode.json`]);
  expect(() =>
    validateV2NativeConfigSources(entries, spec.system, "v2-system-global-config-v1", options),
  ).toThrow();
  expect(() =>
    validateV2NativeConfigSources(
      entries.toReversed(),
      spec.root,
      "v2-system-global-config-v1",
      options,
    ),
  ).toThrow();
  if (spec.platform === "win32") {
    expect(() =>
      selectV2NativeConfigProfile(
        [...entries, { type: "directory", path: spec.root.toLowerCase() }],
        spec.root,
        options,
      ),
    ).toThrow();
    expect(() => selectV2NativeConfigProfile(entries, spec.root, { platform: "win32" })).toThrow(
      "namespace",
    );
    expect(() => selectV2NativeConfigProfile(entries, "\\\\server\\share", options)).toThrow();
  }
});
