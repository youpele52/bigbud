import { describe, expect, it } from "vitest";

import {
  compareReleaseTags,
  parseDownloadRef,
  parseReleaseSummaries,
  rankChannelTags,
  remoteAgentDownloadLocation,
  selectRelease,
  type ReleaseSummary,
} from "./remoteAgentRelease";

const PINNED_PREFIX = "https://github.com/youpele52/bigbud/releases/download/";

function release(tag: string, overrides: Partial<ReleaseSummary> = {}): ReleaseSummary {
  return {
    tag,
    draft: false,
    prerelease: tag.includes("-"),
    assetNames: ["remote-agent.sh", "install.sh"],
    ...overrides,
  };
}

const RELEASES: readonly ReleaseSummary[] = [
  release("v0.3.3", { assetNames: ["install.sh"] }),
  release("v0.4.0-beta.5"),
  release("v0.4.0-beta.10"),
  release("v0.4.0-beta.11", { draft: true }),
  release("v0.4.0-preview.1"),
  release("v0.3.2"),
  release("v0.2.9"),
];

describe("parseDownloadRef", () => {
  it("maps latest and stable to the stable channel", () => {
    expect(parseDownloadRef("latest")).toEqual({ kind: "channel", channel: "stable" });
    expect(parseDownloadRef("stable")).toEqual({ kind: "channel", channel: "stable" });
  });

  it("accepts each prerelease channel", () => {
    for (const channel of ["beta", "preview", "nightly"] as const) {
      expect(parseDownloadRef(channel)).toEqual({ kind: "channel", channel });
    }
  });

  it("accepts every version format the app can pin", () => {
    expect(parseDownloadRef("0.4.0-beta.1.2")).toEqual({ kind: "tag", tag: "v0.4.0-beta.1.2" });
    expect(parseDownloadRef("v0.4.0-nightly.20261120")).toEqual({
      kind: "tag",
      tag: "v0.4.0-nightly.20261120",
    });
  });

  it("normalises tags with or without the leading v", () => {
    expect(parseDownloadRef("0.4.0-beta.6")).toEqual({ kind: "tag", tag: "v0.4.0-beta.6" });
    expect(parseDownloadRef("v0.4.0")).toEqual({ kind: "tag", tag: "v0.4.0" });
  });

  it.each([
    "../v0.4.0",
    "v0.4.0%2f..",
    "..%2fetc",
    "vX",
    "v0.4",
    "v0.4.0-alpha.1",
    "v0.4.0-beta.01",
    "v0.4.0+build.1",
    "v0.4.0\n",
    "v0.4.0\nLocation: https://evil.example",
    `v0.4.0-beta.${"1".repeat(80)}`,
    "",
    "Latest",
    " beta",
  ])("rejects %j", (ref) => {
    expect(parseDownloadRef(ref)).toBeNull();
  });
});

describe("selectRelease", () => {
  it("returns the newest stable release that ships the script, ignoring prereleases", () => {
    expect(selectRelease("stable", RELEASES)).toBe("v0.3.2");
  });

  it("returns null for stable when no stable release ships the script", () => {
    expect(selectRelease("stable", [release("v0.3.3", { assetNames: [] })])).toBeNull();
  });

  it("orders by semver, not by API order", () => {
    expect(selectRelease("beta", RELEASES)).toBe("v0.4.0-beta.10");
  });

  it("picks only its own channel and never falls back", () => {
    expect(selectRelease("preview", RELEASES)).toBe("v0.4.0-preview.1");
    expect(selectRelease("nightly", RELEASES)).toBeNull();
  });

  it("requires the prerelease flag to match the channel", () => {
    expect(selectRelease("beta", [release("v0.4.0-beta.1", { prerelease: false })])).toBeNull();
    expect(selectRelease("stable", [release("v0.4.0", { prerelease: true })])).toBeNull();
  });

  it("skips releases without the exact asset name", () => {
    const releases = [release("v0.4.0-beta.9", { assetNames: ["remote-agent.sh.sig"] })];
    expect(selectRelease("beta", releases)).toBeNull();
  });

  it("ignores tags that do not match the release pattern", () => {
    expect(selectRelease("beta", [release("v0.4.0-beta.1/../x")])).toBeNull();
  });
});

describe("rankChannelTags", () => {
  const tags = ["v0.4.0-beta.9", "0.4.0-beta.10", "v0.4.0-beta.10", "v0.4.0", "v0.4.0-preview.1"];

  it("returns distinct tags of the channel, newest first", () => {
    expect(rankChannelTags("beta", tags)).toEqual(["v0.4.0-beta.10", "v0.4.0-beta.9"]);
    expect(rankChannelTags("stable", tags)).toEqual(["v0.4.0"]);
    expect(rankChannelTags("nightly", tags)).toEqual([]);
  });

  it("drops invalid tags", () => {
    expect(rankChannelTags("beta", ["v0.4.0-beta.1/../x", "v0.4.0-beta.01", "beta"])).toEqual([]);
  });
});

describe("compareReleaseTags", () => {
  it("sorts stable after its prereleases", () => {
    expect(compareReleaseTags("v0.4.0", "v0.4.0-beta.9")).toBeGreaterThan(0);
    expect(compareReleaseTags("v0.4.1-beta.1", "v0.4.0")).toBeGreaterThan(0);
  });
});

describe("parseReleaseSummaries", () => {
  it("drops malformed entries and reads asset names", () => {
    const parsed = parseReleaseSummaries([
      { tag_name: "v0.4.0-beta.5", prerelease: true, assets: [{ name: "remote-agent.sh" }, 3] },
      { tag_name: 7, assets: [] },
      null,
      { tag_name: "v0.4.0" },
    ]);
    expect(parsed).toEqual([
      { tag: "v0.4.0-beta.5", draft: false, prerelease: true, assetNames: ["remote-agent.sh"] },
    ]);
    expect(parseReleaseSummaries({ message: "rate limited" })).toEqual([]);
  });
});

describe("remoteAgentDownloadLocation", () => {
  it("always points at the pinned repository asset", () => {
    expect(remoteAgentDownloadLocation("0.4.0-beta.6")).toBe(
      `${PINNED_PREFIX}v0.4.0-beta.6/remote-agent.sh`,
    );
  });

  it("re-validates tags, including ones from the API", () => {
    expect(remoteAgentDownloadLocation("v0.4.0/../../evil")).toBeNull();
    expect(remoteAgentDownloadLocation("https://evil.example")).toBeNull();
  });
});
