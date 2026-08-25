import { describe, expect, it } from "vitest";

import {
  releaseChannelLabel,
  resolveReleaseChannel,
  resolveReleaseVersion,
} from "./releaseChannel";

describe("release channel", () => {
  it.each([
    ["0.1.642-beta-2", "beta"],
    ["v0.1.642-preview.2", "preview"],
    ["0.1.642-nightly-20260726", "nightly"],
  ] as const)("resolves %s as %s", (version, channel) => {
    expect(resolveReleaseChannel(version)).toBe(channel);
  });

  it.each(["0.1.642", "0.1.642-test.1", "not-a-version"])(
    "does not resolve %s as an approved channel",
    (version) => {
      expect(resolveReleaseChannel(version)).toBeNull();
    },
  );

  it("returns display labels", () => {
    expect(releaseChannelLabel("beta")).toBe("Beta");
    expect(releaseChannelLabel("preview")).toBe("Preview");
    expect(releaseChannelLabel("nightly")).toBe("Nightly");
  });

  it.each([
    ["1.2.3", { channel: "stable", isPrerelease: false, version: "1.2.3" }],
    ["v1.2.3-beta.1", { channel: "beta", isPrerelease: true, version: "1.2.3-beta.1" }],
    ["1.2.3-preview-2", { channel: "preview", isPrerelease: true, version: "1.2.3-preview-2" }],
    [
      "1.2.3-nightly.20260824",
      { channel: "nightly", isPrerelease: true, version: "1.2.3-nightly.20260824" },
    ],
  ] as const)("strictly resolves public version %s", (version, expected) => {
    expect(resolveReleaseVersion(version)).toEqual(expected);
  });

  it.each([
    "1.2.3.foo",
    "1.2.3-rc.1",
    "1.2.3-BETA.1",
    "1.2.3-beta..1",
    "1.2.3-beta.01",
    "1.2.3-beta-",
    "01.2.3",
    "1.02.3",
    "1.2",
    "not-a-version",
  ])("rejects unsupported public version %s", (version) => {
    expect(resolveReleaseVersion(version)).toBeNull();
  });
});
