import { symlink, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  CommandId,
  ThreadId,
  ProjectId,
  LOCAL_EXECUTION_TARGET_ID,
} from "@bigbud/contracts/core/baseSchemas.ts";
import type { WorktreeBinding } from "@bigbud/contracts/workspace/worktreeBinding.ts";
import { describe, expect, it } from "vitest";
import { worktreeFixture } from "./WorktreeLifecycle.test.helpers.ts";
import { assertWorktreeDraftBinding } from "./WorktreeDraftBinding.ts";

describe("offline draft workspace identity", () => {
  it("rejects a reused symlink destination before canonical creation or any provider spawn", async () => {
    const h = await worktreeFixture();
    try {
      const alias = path.join(h.root, "alias");
      await symlink(h.worktree, alias);
      const request = await h.request();
      const binding: WorktreeBinding = {
        path: alias,
        identity: request.expectedIdentity,
        repository: (await h.runtime.runPromise(h.service.inventory({ cwd: h.repo }))).repository,
        executionTargetId: LOCAL_EXECUTION_TARGET_ID,
        revision: 0,
      };
      await h.git(["worktree", "move", h.worktree, path.join(h.root, "externally-moved")]);
      await mkdir(h.worktree);
      await expect(
        h.runtime.runPromise(
          h.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe("stale-alias-create"),
            threadId: ThreadId.makeUnsafe("offline-alias"),
            projectId: ProjectId.makeUnsafe("project"),
            title: "Offline",
            modelSelection: { provider: "codex", model: "test" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "different-branch",
            worktreePath: alias,
            worktreeBinding: binding,
            createdAt: new Date().toISOString(),
          }),
        ),
      ).rejects.toThrow("another folder");
      expect(await h.runtime.runPromise(h.sql`SELECT * FROM projection_threads`)).toHaveLength(0);
      expect(
        await h.runtime.runPromise(h.sql`SELECT * FROM provider_session_runtime`),
      ).toHaveLength(0);
    } finally {
      await h.dispose();
    }
  });
  it("retains identity through an external alias move and rejects incompatible targets or future state", async () => {
    const h = await worktreeFixture();
    try {
      const alias = path.join(h.root, "alias");
      await symlink(h.worktree, alias);
      const request = await h.request();
      const binding: WorktreeBinding = {
        path: alias,
        identity: request.expectedIdentity,
        repository: (await h.runtime.runPromise(h.service.inventory({ cwd: h.repo }))).repository,
        executionTargetId: LOCAL_EXECUTION_TARGET_ID,
        revision: 0,
      };
      await h.runtime.runPromise(assertWorktreeDraftBinding(h.sql, binding, alias, "local"));
      const destination = path.join(h.root, "externally-moved");
      await h.git(["worktree", "move", h.worktree, destination]);
      await rm(alias);
      await symlink(destination, alias);
      await h.runtime.runPromise(assertWorktreeDraftBinding(h.sql, binding, alias, "local"));
      await expect(
        h.runtime.runPromise(
          assertWorktreeDraftBinding(h.sql, { ...binding, revision: 99 }, alias, "local"),
        ),
      ).rejects.toThrow("another server state");
      await expect(
        h.runtime.runPromise(assertWorktreeDraftBinding(h.sql, binding, alias, "ssh:other")),
      ).rejects.toThrow("target changed");
    } finally {
      await h.dispose();
    }
  });
});
