import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MAX_FEED_BYTES, MAX_FEED_ENTRIES, parseReleaseFeedTags } from "./remoteAgentFeed";
import { atomEntry, atomFeed } from "./remoteAgentTesting";

/** Captured from https://github.com/youpele52/bigbud/releases.atom on 2026-11-21. */
const LIVE_FEED = readFileSync(new URL("./fixtures/releases.atom", import.meta.url), "utf8");

describe("parseReleaseFeedTags", () => {
  it("reads every tag of the live GitHub feed in feed order", () => {
    expect(parseReleaseFeedTags(LIVE_FEED)).toEqual([
      "v0.4.0-beta.6",
      "v0.4.0-beta.5",
      "v0.4.0-beta.4",
      "v0.4.0-beta.3",
      "v0.4.0-beta.2",
      "v0.4.0-beta.1",
      "v0.3.3",
      "v0.3.2",
      "v0.3.1",
      "v0.3.0",
    ]);
  });

  it("falls back to the entry id when the link is missing", () => {
    const xml = atomFeed([
      `<entry><id>tag:github.com,2008:Repository/1/v0.4.0-preview.2</id></entry>`,
    ]);
    expect(parseReleaseFeedTags(xml)).toEqual(["v0.4.0-preview.2"]);
  });

  it("drops tags that fail the release version pattern", () => {
    const xml = atomFeed([
      atomEntry("v0.4.0-alpha.1"),
      atomEntry("v0.4.0-beta.01"),
      atomEntry("v0.4.0%2F..%2Fevil"),
      atomEntry("latest"),
      atomEntry("v0.4.0-beta.7"),
      `<entry><link href="https://github.com/someone/else/releases/tag/v9.9.9"/></entry>`,
    ]);
    expect(parseReleaseFeedTags(xml)).toEqual(["v0.4.0-beta.7"]);
  });

  it("returns null for a document that is not a feed", () => {
    expect(parseReleaseFeedTags("<html><body>Rate limited</body></html>")).toBeNull();
    expect(parseReleaseFeedTags("")).toBeNull();
  });

  it("returns null for an oversized feed", () => {
    const xml = atomFeed([atomEntry("v0.4.0-beta.7"), "x".repeat(MAX_FEED_BYTES)]);
    expect(parseReleaseFeedTags(xml)).toBeNull();
  });

  it("stops at an unterminated entry", () => {
    const unterminated = atomEntry("v0.4.0-beta.8").replace("</entry>", "");
    const xml = atomFeed([atomEntry("v0.4.0-beta.7"), unterminated]);
    expect(parseReleaseFeedTags(xml)).toEqual(["v0.4.0-beta.7"]);
  });

  it("reads at most the entry limit", () => {
    const entries = Array.from({ length: MAX_FEED_ENTRIES + 5 }, (_, index) =>
      atomEntry(`v0.4.0-nightly.${index + 1}`),
    );
    expect(parseReleaseFeedTags(atomFeed(entries))).toHaveLength(MAX_FEED_ENTRIES);
  });
});
