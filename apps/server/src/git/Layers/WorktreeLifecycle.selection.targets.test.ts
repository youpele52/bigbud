import { expect, it, vi } from "vitest";
import { worktreeFixture } from "./WorktreeLifecycle.test.helpers.ts";
import { makeWorktreeSelection } from "./WorktreeLifecycle.selection.ts";

it("rejects unsupported remote selection before inventory or host path resolution", async () => {
  const h = await worktreeFixture();
  try {
    const threadId = await h.addThread("saved");
    const execute = vi.fn(h.core.execute);
    const select = makeWorktreeSelection({
      sql: h.sql,
      git: { ...h.core, execute },
      engine: h.engine,
    });
    for (const executionTargetId of ["ssh:fixture", "wsl:Ubuntu", "remote-agent:fixture"]) {
      await expect(
        h.runtime.runPromise(
          select({
            cwd: h.repo,
            path: h.worktree,
            threadId,
            commandId: crypto.randomUUID(),
            expectedPath: h.worktree,
            expectedIdentity: "not-used",
            executionTargetId,
          }),
        ),
      ).rejects.toThrow("No host filesystem lookup or local fallback");
    }
    expect(execute).not.toHaveBeenCalled();
    const [thread] = await h.runtime.runPromise(
      h.sql<{
        readonly path: string;
      }>`SELECT worktree_path AS path FROM projection_threads WHERE thread_id = ${threadId}`,
    );
    expect(thread?.path).toBe(h.worktree);
  } finally {
    await h.dispose();
  }
});
