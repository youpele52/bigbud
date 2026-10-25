import { assert, describe, it } from "vitest";

import { getVscodeIconUrlForEntry } from "./icons.lib";

describe("getVscodeIconUrlForEntry", () => {
  it("uses Material Icon Theme filename mappings and theme variants", () => {
    const darkUrl = getVscodeIconUrlForEntry("pnpm-workspace.yaml", "file", "dark");
    const lightUrl = getVscodeIconUrlForEntry("pnpm-workspace.yaml", "file", "light");

    assert.isTrue(darkUrl.endsWith("/icons/pnpm.svg"));
    assert.isTrue(lightUrl.endsWith("/icons/pnpm_light.svg"));
  });

  it("uses compound extensions and folder-name mappings", () => {
    const fileUrl = getVscodeIconUrlForEntry("tsconfig.tsbuildinfo", "file", "dark");
    const folderUrl = getVscodeIconUrlForEntry("packages/src", "directory", "light");

    assert.isTrue(fileUrl.endsWith("/icons/json.svg"));
    assert.isTrue(folderUrl.endsWith("/icons/folder-src.svg"));
  });

  it("supports language and framework icons", () => {
    const tsxUrl = getVscodeIconUrlForEntry("checkbox.tsx", "file", "light");
    const dockerfileUrl = getVscodeIconUrlForEntry("Dockerfile", "file", "dark");
    const htmlUrl = getVscodeIconUrlForEntry("index.html", "file", "dark");
    const agentsUrl = getVscodeIconUrlForEntry("AGENTS.md", "file", "light");

    assert.isTrue(tsxUrl.endsWith("/icons/react_ts.svg"));
    assert.isTrue(dockerfileUrl.endsWith("/icons/docker.svg"));
    assert.isTrue(htmlUrl.endsWith("/icons/html.svg"));
    assert.isTrue(agentsUrl.endsWith("/icons/agent.svg"));
  });

  it("falls back to default file and folder icons when there is no match", () => {
    const fileUrl = getVscodeIconUrlForEntry("foo.unknown-ext", "file", "dark");
    const folderUrl = getVscodeIconUrlForEntry("totally-unknown-folder", "directory", "dark");

    assert.isTrue(fileUrl.endsWith("/icons/file.svg"));
    assert.isTrue(folderUrl.endsWith("/icons/folder.svg"));
  });
});
