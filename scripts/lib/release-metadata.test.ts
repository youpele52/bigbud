import { describe, expect, it } from "vitest";

import {
  macArchitectureManifestName,
  macUpdateManifestName,
  resolveReleaseMetadata,
} from "./release-metadata";

describe("release metadata", () => {
  it.each([
    ["1.2.3", "stable", "latest", false, true],
    ["v1.2.3-beta.1", "beta", "beta", true, false],
    ["1.2.3-preview-2", "preview", "preview", true, false],
    ["1.2.3-nightly.20260824", "nightly", "nightly", true, false],
  ] as const)("resolves %s", (input, channel, updateChannel, isPrerelease, makeLatest) => {
    const metadata = resolveReleaseMetadata(input);
    expect(metadata).toEqual({
      channel,
      isPrerelease,
      makeLatest,
      tag: `v${metadata.version}`,
      updateChannel,
      version: input.replace(/^v/, ""),
    });
    expect(macUpdateManifestName(metadata.updateChannel)).toBe(`${updateChannel}-mac.yml`);
    expect(macArchitectureManifestName(metadata.updateChannel, "x64")).toBe(
      `${updateChannel}-mac-x64.yml`,
    );
  });

  it.each(["1.2.3.foo", "1.2.3-alpha.1", "1.2.3-beta..1", "1.2.3-preview-", "01.2.3", "1.2"])(
    "rejects unsupported version %s",
    (version) => {
      expect(() => resolveReleaseMetadata(version)).toThrow(
        `Invalid or unsupported release version: ${version}`,
      );
    },
  );
});
