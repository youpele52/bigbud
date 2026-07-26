import { describe, expect, it } from "vitest";

import { releaseChannelLabel, resolveReleaseChannel } from "./releaseChannel";

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
});
