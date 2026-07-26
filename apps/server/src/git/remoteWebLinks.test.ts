import { describe, expect, it } from "vitest";

import { buildRemoteWebLinks } from "./remoteWebLinks.ts";

describe("buildRemoteWebLinks", () => {
  it.each([
    ["https://github.com/acme/project.git/", "https://github.com/acme/project"],
    ["git@github.com:acme/project.git", "https://github.com/acme/project"],
    ["ssh://git@github.com/acme/project", "https://github.com/acme/project"],
    ["git://github.com/acme/project.git", "https://github.com/acme/project"],
  ])("parses GitHub remote %s", (remoteUrl, repositoryUrl) => {
    expect(buildRemoteWebLinks(remoteUrl, "feature/a b")).toEqual({
      provider: "github",
      repositoryUrl,
      branchUrl: `${repositoryUrl}/tree/feature%2Fa%20b`,
    });
  });

  it.each([
    ["https://gitlab.com/acme/platform/project.git", "https://gitlab.com/acme/platform/project"],
    ["git@gitlab.com:acme/platform/project", "https://gitlab.com/acme/platform/project"],
    ["ssh://git@gitlab.com/acme/platform/project.git", "https://gitlab.com/acme/platform/project"],
    ["git://gitlab.com/acme/platform/project/", "https://gitlab.com/acme/platform/project"],
  ])("parses nested GitLab remote %s", (remoteUrl, repositoryUrl) => {
    expect(buildRemoteWebLinks(remoteUrl, "release/v1")).toEqual({
      provider: "gitlab",
      repositoryUrl,
      branchUrl: `${repositoryUrl}/-/tree/release%2Fv1`,
    });
  });

  it.each([
    "https://example.com/acme/project.git",
    "http://github.com/acme/project.git",
    "file:///tmp/project.git",
    "/tmp/project.git",
    "../project",
    "ssh://user@github.com/acme/project.git",
    "https://github.com/acme",
    "https://github.com/acme/project/extra",
    "https://gitlab.com/acme//project",
    "not a remote",
  ])("rejects unsupported or malformed remote %s", (remoteUrl) => {
    expect(buildRemoteWebLinks(remoteUrl, "main")).toBeNull();
  });
});
