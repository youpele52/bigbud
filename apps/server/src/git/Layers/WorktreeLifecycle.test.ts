import { writeFile, access, rm } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { worktreeFixture } from "./WorktreeLifecycle.test.helpers.ts";

it("protects saved references, untracked data, and the main checkout", async () => {
  const h = await worktreeFixture();
  try {
    await writeFile(path.join(h.worktree, "untracked"), "keep");
    await expect(
      h.runtime.runPromise(h.service.mutate("delete", await h.request())),
    ).rejects.toThrow("untracked or ignored");
    await rm(path.join(h.worktree, "untracked"));
    await h.addThread("saved");
    await expect(
      h.runtime.runPromise(h.service.mutate("delete", await h.request())),
    ).rejects.toThrow("saved chat");
    await expect(
      h.runtime.runPromise(h.service.mutate("delete", { ...(await h.request()), path: h.repo })),
    ).rejects.toThrow("main/locked");
    await access(h.worktree);
  } finally {
    await h.dispose();
  }
});

it("removes only a clean unreferenced checkout and retains its branch", async () => {
  const h = await worktreeFixture();
  try {
    const request = await h.request();
    await h.runtime.runPromise(h.service.mutate("delete", request));
    await h.runtime.runPromise(h.service.mutate("delete", request));
    await expect(access(h.worktree)).rejects.toThrow();
    expect((await h.git(["show-ref", "--verify", "refs/heads/different-branch"])).stdout).toContain(
      "refs/heads/different-branch",
    );
  } finally {
    await h.dispose();
  }
});

it("rejects ignored and tracked data rather than treating it as disposable", async () => {
  const h = await worktreeFixture();
  try {
    await writeFile(path.join(h.worktree, "README.md"), "dirty");
    await expect(
      h.runtime.runPromise(h.service.mutate("delete", await h.request())),
    ).rejects.toThrow("untracked or ignored");
    await h.git(["-C", h.worktree, "restore", "README.md"]);
    await writeFile(path.join(h.repo, ".git", "info", "exclude"), "ignored\n");
    await writeFile(path.join(h.worktree, "ignored"), "keep");
    await expect(
      h.runtime.runPromise(h.service.mutate("delete", await h.request())),
    ).rejects.toThrow("untracked or ignored");
    await access(path.join(h.worktree, "ignored"));
  } finally {
    await h.dispose();
  }
});

it("rejects remote deletion without any local mutation", async () => {
  const h = await worktreeFixture();
  try {
    await expect(
      h.runtime.runPromise(
        h.service.mutate("delete", { ...(await h.request()), executionTargetId: "ssh:test" }),
      ),
    ).rejects.toThrow("no local operation");
    await access(h.worktree);
    expect(await h.runtime.runPromise(h.sql`SELECT * FROM worktree_operations`)).toHaveLength(0);
  } finally {
    await h.dispose();
  }
});

it("blocks an active session and preserves the checkout", async () => {
  const h = await worktreeFixture();
  try {
    const id = await h.addThread("active");
    await h.runtime
      .runPromise(h.sql`INSERT INTO provider_session_runtime(thread_id,provider_name,adapter_key,status,last_seen_at,runtime_payload_json)
      VALUES (${id},'codex','codex','running','fixture',${JSON.stringify({ cwd: h.worktree })})`);
    await expect(
      h.runtime.runPromise(h.service.mutate("delete", await h.request())),
    ).rejects.toThrow("active session");
    await access(h.worktree);
  } finally {
    await h.dispose();
  }
});

it("rechecks a lost deletion acknowledgement without re-dispatching physical deletion", async () => {
  const h = await worktreeFixture();
  try {
    const request = await h.request();
    h.control.loseRemoveAck = true;
    await expect(h.runtime.runPromise(h.service.mutate("delete", request))).rejects.toThrow(
      "Lost remove",
    );
    await expect(access(h.worktree)).rejects.toThrow();
    const recovered = await h.runtime.runPromise(
      h.service.recoverOperation({ cwd: h.repo, operationId: request.operationId }),
    );
    expect(recovered.phase).toBe("completed");
    expect(await h.runtime.runPromise(h.sql`PRAGMA foreign_key_check`)).toEqual([]);
  } finally {
    await h.dispose();
  }
});
