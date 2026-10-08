import { mkdir, symlink, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { v2LocalToolPolicy } from "./Runtime.policy.ts";
import { assertV2WorkspaceStorageSeparate } from "./Runtime.workspaceBoundary.ts";
import { readV2ApplicationConfig } from "./Application.config.ts";
import { lstat } from "node:fs/promises";

it("configuration rejects repository-contained storage before creating or adopting it", async () => {
  await withV2RuntimeFixture(async ({ directory }) => {
    await mkdir(path.join(directory, ".git"));
    const profile = path.join(directory, "new-profile");
    await expect(
      readV2ApplicationConfig({ binaryPath: "/synthetic/opencode", profileRoot: profile }),
    ).rejects.toThrow("storage");
    await expect(lstat(profile)).rejects.toThrow();
  });
});

it("rejects storage in a linked worktree's canonical common repository even outside the worktree", async () => {
  await withV2RuntimeFixture(async ({ runtime }) => {
    const repository = path.dirname(runtime.options.config.profileRoot);
    const gitDir = path.join(repository, ".git", "worktrees", "synthetic");
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(gitDir, "commondir"), "../..\n");
    const linked = await mkdtemp(path.join(os.tmpdir(), "v2-linked-worktree-"));
    try {
      await writeFile(path.join(linked, ".git"), `gitdir: ${gitDir}\n`);
      await expect(
        assertV2WorkspaceStorageSeparate(runtime.options.config.profileRoot, linked),
      ).rejects.toThrow("storage");
    } finally {
      await rm(linked, { recursive: true, force: true });
    }
  });
});

it.each(["approval-required", "auto-accept-edits", "full-access"] as const)(
  "denies unconstrained native filesystem/shell actions in %s",
  (mode) => {
    const rules = v2LocalToolPolicy(mode, true);
    for (const action of ["read", "edit", "glob", "grep", "skill", "shell", "external_directory"])
      expect(rules.findLast((rule) => rule.action === action || rule.action === "*")?.effect).toBe(
        "deny",
      );
  },
);

it.each(["same", "ancestor", "inside", "alias", "repository"])(
  "rejects %s profile/workspace overlap before process acquisition",
  async (kind) => {
    await withV2RuntimeFixture(async ({ runtime, directory }) => {
      Object.assign(runtime.options, { allowLocalWorkspace: true });
      const profile = runtime.options.config.profileRoot;
      let cwd =
        kind === "same"
          ? profile
          : kind === "ancestor"
            ? path.dirname(profile)
            : path.join(profile, "nested");
      if (kind === "inside") await mkdir(cwd);
      if (kind === "alias") {
        cwd = path.join(profile, "alias");
        await symlink(profile, cwd);
      }
      if (kind === "repository") {
        cwd = directory;
        await mkdir(path.join(path.dirname(profile), ".git"));
      }
      const acquire = vi.spyOn(runtime.options.manager, "acquire");
      await expect(
        runtime.start({
          threadId: ThreadId.makeUnsafe(`boundary-${kind}`),
          cwd,
          runtimeMode: "approval-required",
          modelSelection: {
            provider: "opencodeV2",
            subProviderID: "synthetic-provider",
            model: "synthetic-model",
          },
        }),
      ).rejects.toThrow("storage");
      expect(acquire).not.toHaveBeenCalled();
    });
  },
);
