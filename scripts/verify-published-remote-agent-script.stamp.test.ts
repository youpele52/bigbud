import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  normalizeStampedScript,
  resolvedReleaseTag,
  stampForTag,
  validateDownloadRef,
} from "./verify-published-remote-agent-script.stamp.ts";

const repositoryScript = readFileSync(new URL("./release-assets/remote-agent.sh", import.meta.url));

describe("normalizeStampedScript", () => {
  it("finds the single unstamped line in the repository script", () => {
    const { normalized, stamp } = normalizeStampedScript(repositoryScript);
    expect(stamp).toBe("");
    expect(normalized.equals(repositoryScript)).toBe(true);
  });

  it("restores a release-stamped copy to the repository bytes", () => {
    const releaseCopy = Buffer.from(
      repositoryScript
        .toString("utf8")
        .replace(/^DEFAULT_VERSION=""/m, 'DEFAULT_VERSION="0.4.0-beta.6"'),
    );
    const { normalized, stamp } = normalizeStampedScript(releaseCopy);
    expect(stamp).toBe("0.4.0-beta.6");
    expect(normalized.equals(repositoryScript)).toBe(true);
  });

  it("reports a missing stamp line", () => {
    expect(normalizeStampedScript(Buffer.from("#!/bin/sh\n")).stamp).toBeNull();
  });
});

describe("resolvedReleaseTag", () => {
  it("reads the tag from the pinned GitHub release hop", () => {
    const hops = [
      "https://bigbud.app/download/beta/remote-agent",
      "https://github.com/youpele52/bigbud/releases/download/v0.4.0-beta.6/remote-agent.sh",
      "https://release-assets.githubusercontent.com/github-production/abc",
    ];
    expect(resolvedReleaseTag(hops, "youpele52/bigbud")).toBe("v0.4.0-beta.6");
    expect(resolvedReleaseTag(hops, "someone/else")).toBeNull();
    expect(stampForTag("v0.4.0-beta.6")).toBe("0.4.0-beta.6");
  });
});

describe("validateDownloadRef", () => {
  it("accepts channels and tags only", () => {
    for (const ref of [
      "latest",
      "stable",
      "beta",
      "preview",
      "nightly",
      "v0.4.0",
      "0.4.0-beta.6",
    ]) {
      expect(validateDownloadRef(ref)).toBe(ref);
    }
    for (const ref of ["", "vX", "../beta", "beta\n", "0.4.0-alpha.1"]) {
      expect(() => validateDownloadRef(ref)).toThrow();
    }
  });
});
