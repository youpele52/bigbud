import { describe, expect, it } from "vitest";

import {
  checkReleaseState,
  diffReleaseAssets,
  findReleaseByTag,
  formatPublishSummary,
  healReleaseAssets,
  parsePatternList,
  parseReleaseLines,
  parseRemoteAssetLines,
  resolveReleaseFiles,
} from "./release-publish-assets";
import type { LocalAsset, RemoteAsset } from "./release-publish-assets";

const asset = (name: string, size = 10): LocalAsset => ({
  path: `release-assets/${name}`,
  name,
  size,
});
const remote = (name: string, state = "uploaded", size = 10): RemoteAsset => ({
  name,
  state,
  size,
});

describe("release file resolution", () => {
  it("parses a newline-separated pattern list", () => {
    expect(parsePatternList("  a/*.exe \n\n b/*.zip\r\n")).toEqual(["a/*.exe", "b/*.zip"]);
  });

  it("uploads a file matched by two patterns once (the v0.4.0-beta.3 failure)", () => {
    const exe = "release-assets/server-workspace-agent-win32-x64.exe";
    const resolved = resolveReleaseFiles([
      { pattern: "release-assets/*.exe", files: ["release-assets/bigbud-x64.exe", exe] },
      {
        pattern: "release-assets/server-workspace-agent-*",
        files: [exe, "release-assets/server-workspace-agent-linux-x64"],
      },
    ]);
    expect(resolved.problems).toEqual([]);
    expect(resolved.files).toEqual([
      "release-assets/bigbud-x64.exe",
      exe,
      "release-assets/server-workspace-agent-linux-x64",
    ]);
  });

  it("fails on an unmatched pattern, a name from two files, and glob characters", () => {
    const resolved = resolveReleaseFiles([
      { pattern: "release-assets/*.dmg", files: [] },
      { pattern: "a/*", files: ["a/install.sh", "a/odd[1].zip"] },
      { pattern: "b/*", files: ["b/install.sh"] },
    ]);
    expect(resolved.problems).toEqual([
      "Pattern 'release-assets/*.dmg' does not match any files.",
      "File 'a/odd[1].zip' contains glob characters.",
      "Asset name 'install.sh' would come from both a/install.sh and b/install.sh.",
    ]);
  });
});

describe("release asset diff", () => {
  it("classifies missing, incomplete, wrong-size and extra assets", () => {
    const diff = diffReleaseAssets(
      [asset("a.exe"), asset("b.exe"), asset("c.zip"), asset("d.yml")],
      [
        remote("b.exe", "open"),
        remote("c.zip", "uploaded", 9),
        remote("d.yml"),
        remote("manual.txt"),
      ],
    );
    expect(diff).toEqual({
      missing: ["a.exe"],
      notUploaded: ["b.exe"],
      sizeMismatch: ["c.zip"],
      extra: ["manual.txt"],
    });
  });

  it("parses gh --jq asset and release lines", () => {
    expect(parseRemoteAssetLines('{"name":"a.exe","state":"uploaded","size":3}\n\n')).toEqual([
      remote("a.exe", "uploaded", 3),
    ]);
    expect(() => parseRemoteAssetLines('{"size":3}')).toThrow("no name or state");
    expect(
      parseReleaseLines('{"id":1,"tag_name":"v1.0.0","draft":true,"prerelease":false}'),
    ).toEqual([{ id: 1, tagName: "v1.0.0", draft: true, prerelease: false }]);
  });
});

const release = (id: number, tagName: string, draft = false) => ({
  id,
  tagName,
  draft,
  prerelease: false,
});

describe("release lookup and state", () => {
  it("prefers the published release, finds a leftover draft, and reports ambiguity", () => {
    expect(findReleaseByTag([release(1, "v1", true), release(2, "v1")], "v1").release?.id).toBe(2);
    expect(findReleaseByTag([release(3, "v1", true)], "v1").release?.id).toBe(3);
    expect(findReleaseByTag([release(4, "v2")], "v1").problem).toContain("No release");
    expect(findReleaseByTag([release(5, "v1"), release(6, "v1")], "v1").problem).toContain(
      "More than one published",
    );
  });

  it("requires the published tag with the expected prerelease flag", () => {
    const ok = { tag_name: "v1", draft: false, prerelease: true };
    expect(checkReleaseState(ok, { tag: "v1", prerelease: true })).toEqual([]);
    expect(
      checkReleaseState({ ...ok, draft: true, prerelease: false }, { tag: "v1", prerelease: true }),
    ).toEqual(["Release is still a draft.", "Release prerelease is false, expected true."]);
  });
});

describe("healReleaseAssets", () => {
  function fakeRelease(initial: RemoteAsset[], failUploads: Record<string, number> = {}) {
    const assets = new Map(initial.map((entry) => [entry.name, entry]));
    const uploads: string[] = [];
    return {
      uploads,
      options: {
        listAssets: async () => [...assets.values()],
        upload: async (local: LocalAsset) => {
          uploads.push(local.name);
          if ((failUploads[local.name] ?? 0) > 0) {
            failUploads[local.name]! -= 1;
            throw new Error("HTTP 502");
          }
          assets.set(local.name, remote(local.name, "uploaded", local.size));
        },
        sleep: async () => {},
        retryDelayMs: 1,
        log: () => {},
      },
    };
  }

  it("re-uploads the missing supervisors and passes once the release is complete", async () => {
    const expected = [asset("server-organization-supervisor-win32-x64.exe"), asset("bigbud.dmg")];
    const fake = fakeRelease([remote("bigbud.dmg")]);
    const result = await healReleaseAssets({ expected, attempts: 3, ...fake.options });
    expect(result.problems).toEqual([]);
    expect(result.repaired).toEqual(["server-organization-supervisor-win32-x64.exe"]);
    expect(fake.uploads).toEqual(["server-organization-supervisor-win32-x64.exe"]);
  });

  it("retries a failed upload and replaces an incomplete asset", async () => {
    const expected = [asset("a.exe"), asset("b.exe")];
    const fake = fakeRelease([remote("b.exe", "open")], { "a.exe": 1 });
    const result = await healReleaseAssets({ expected, attempts: 3, ...fake.options });
    expect(result.problems).toEqual([]);
    expect(fake.uploads).toEqual(["a.exe", "b.exe", "a.exe"]);
  });

  it("does nothing when every asset is already uploaded", async () => {
    const fake = fakeRelease([remote("a.exe")]);
    const result = await healReleaseAssets({
      expected: [asset("a.exe")],
      attempts: 3,
      ...fake.options,
    });
    expect(result.problems).toEqual([]);
    expect(fake.uploads).toEqual([]);
  });

  it("fails after the bounded attempts when an upload keeps failing", async () => {
    const fake = fakeRelease([], { "a.exe": 99 });
    const result = await healReleaseAssets({
      expected: [asset("a.exe")],
      attempts: 2,
      ...fake.options,
    });
    expect(fake.uploads).toHaveLength(2);
    expect(result.problems).toEqual(["a.exe: missing from the release"]);
    const summary = formatPublishSummary("v1", 1, result, []);
    expect(summary).toContain("verification failed with 1 problem(s)");
    expect(summary).toContain("- a.exe: missing from the release");
  });
});
