import { mkdtemp, mkdir, realpath, writeFile, symlink, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { readV2DevelopmentConfig, V2_DEVELOPMENT_MARKER } from "./Development.config.ts";

it("requires explicit marked ownership and a separate workspace without credential discovery", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "v2-development-config-")));
  try {
    const workspace = path.join(root, "workspace");
    const profile = path.join(root, "profile");
    await mkdir(profile, { mode: 0o700 });
    await mkdir(workspace);
    const environment = {
      BIGBUD_OPENCODE_V2_BINARY: path.join(root, "explicit-binary"),
      BIGBUD_OPENCODE_V2_PROFILE_ROOT: profile,
      BIGBUD_OPENCODE_V2_WORKSPACE: workspace,
    };
    await expect(readV2DevelopmentConfig({})).rejects.toThrow("explicit");
    await expect(readV2DevelopmentConfig(environment)).rejects.toThrow();
    await writeFile(
      path.join(profile, V2_DEVELOPMENT_MARKER),
      "bigbud-opencode-v2-disposable-v1\n",
      {
        mode: 0o600,
      },
    );
    expect((await readV2DevelopmentConfig(environment)).workspace).toBe(workspace);
    await expect(
      readV2DevelopmentConfig({ ...environment, BIGBUD_OPENCODE_V2_WORKSPACE: root }),
    ).rejects.toThrow("storage");
    await symlink(workspace, path.join(profile, "config"), "dir");
    await expect(readV2DevelopmentConfig(environment)).rejects.toThrow("links");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
