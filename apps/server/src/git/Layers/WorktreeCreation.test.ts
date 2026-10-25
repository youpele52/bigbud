import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { worktreeFixture } from "./WorktreeLifecycle.test.helpers.ts";
import { CommandId } from "@bigbud/contracts/core/baseSchemas.ts";

describe("immediate physical worktree creation", () => {
  it("creates independently without stopping or changing the current active chat", async () => {
    const h = await worktreeFixture();
    try {
      const threadId = await h.addThread("active");
      const now = new Date().toISOString();
      await h.runtime.runPromise(
        h.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("start"),
          threadId,
          createdAt: now,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        }),
      );
      await h.runtime.runPromise(
        h.service.create({
          cwd: h.repo,
          name: "independent",
          branch: "main",
          newBranch: "feature/independent",
          operationId: crypto.randomUUID(),
        }),
      );
      const [session] = await h.runtime.runPromise(
        h.sql<{
          readonly status: string;
        }>`SELECT status FROM projection_thread_sessions WHERE thread_id = ${threadId}`,
      );
      const [thread] = await h.runtime.runPromise(
        h.sql<{
          readonly path: string;
        }>`SELECT worktree_path AS path FROM projection_threads WHERE thread_id = ${threadId}`,
      );
      expect(session?.status).toBe("running");
      expect(thread?.path).toBe(h.worktree);
    } finally {
      await h.dispose();
    }
  });
  it("keeps folder name separate from its new branch and does not select or mutate a chat", async () => {
    const h = await worktreeFixture();
    try {
      await h.addThread("unchanged");
      const request = {
        cwd: h.repo,
        name: "chosen-folder",
        branch: "main",
        newBranch: "feature/new",
        operationId: crypto.randomUUID(),
      };
      const created = await h.runtime.runPromise(h.service.create(request));
      expect(path.basename(created.path)).toBe("chosen-folder");
      expect(created.branch).toBe("feature/new");
      await access(path.join(created.path, "README.md"));
      const [thread] = await h.runtime.runPromise(
        h.sql<{ readonly cwd: string }>`SELECT worktree_path AS cwd FROM projection_threads`,
      );
      expect(thread?.cwd).toBe(h.worktree);
      expect(await h.runtime.runPromise(h.service.create(request))).toEqual(created);
    } finally {
      await h.dispose();
    }
  });
  it("recovers a lost acknowledgement using the reserved directory identity", async () => {
    const h = await worktreeFixture();
    try {
      h.control.loseAddAck = true;
      const request = {
        cwd: h.repo,
        name: "lost-ack",
        branch: "main",
        newBranch: "feature/lost",
        operationId: crypto.randomUUID(),
      };
      await expect(h.runtime.runPromise(h.service.create(request))).rejects.toThrow(
        "Lost add acknowledgement",
      );
      await h.runtime.runPromise(h.service.recover);
      const created = await h.runtime.runPromise(h.service.create(request));
      await access(created.path);
      const inventory = await h.runtime.runPromise(h.service.inventory({ cwd: h.repo }));
      expect(inventory.entries.filter((entry) => entry.branch === "feature/lost")).toHaveLength(1);
    } finally {
      await h.dispose();
    }
  });
  it("never adopts or deletes a conflicting pre-existing folder", async () => {
    const h = await worktreeFixture();
    try {
      const destination = path.join(h.root, "trees", "repo", "exists");
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, "keep"), "user-data");
      await expect(
        h.runtime.runPromise(
          h.service.create({
            cwd: h.repo,
            name: "exists",
            branch: "main",
            newBranch: "feature/collision",
            operationId: crypto.randomUUID(),
          }),
        ),
      ).rejects.toThrow("already exists");
      await access(path.join(destination, "keep"));
    } finally {
      await h.dispose();
    }
  });
  it.each(["../escape", "a/b", "bad\\path", "CON", "bad "])(
    "rejects unsafe folder name %s",
    async (name) => {
      const h = await worktreeFixture();
      try {
        await expect(
          h.runtime.runPromise(
            h.service.create({
              cwd: h.repo,
              name,
              branch: "main",
              newBranch: "feature/invalid",
              operationId: crypto.randomUUID(),
            }),
          ),
        ).rejects.toThrow("folder name");
      } finally {
        await h.dispose();
      }
    },
  );
});
