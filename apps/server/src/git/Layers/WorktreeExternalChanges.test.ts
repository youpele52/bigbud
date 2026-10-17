import { access, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { CommandId } from "@bigbud/contracts/core/baseSchemas.ts";
import { expect, it } from "vitest";
import { worktreeFixture } from "./WorktreeLifecycle.test.helpers.ts";
import { reconcileExternalWorktreeChanges } from "./WorktreeExternalChanges.ts";
import { assertSavedWorktreeIdentity } from "./WorktreeSavedIdentity.ts";
import { assertProviderWorktreeIdentity } from "../../provider/Layers/ProviderService.worktreeIdentity.ts";

it("follows an external Git move by saved identity and publishes canonical archived-chat metadata", async () => {
  const h = await worktreeFixture();
  try {
    const id = await h.addThread("archived");
    await h.runtime.runPromise(
      h.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("archive"),
        threadId: id,
      }),
    );
    await h.runtime
      .runPromise(h.sql`INSERT INTO provider_session_runtime(thread_id,provider_name,adapter_key,status,last_seen_at,runtime_payload_json)
      VALUES (${id},'codex','codex','stopped','fixture',${JSON.stringify({ cwd: h.worktree, opaque: "keep" })})`);
    const destination = path.join(h.root, "agent-renamed");
    await h.git(["worktree", "move", h.worktree, destination]);
    const listing = await h.runtime.runPromise(h.service.inventory({ cwd: h.repo }));
    expect(
      await h.runtime.runPromise(reconcileExternalWorktreeChanges(h.sql, h.engine, listing)),
    ).toEqual([]);
    const [thread] = await h.runtime.runPromise(
      h.sql<{
        path: string;
        canonical: string;
        archived: string | null;
      }>`SELECT worktree_path AS path,worktree_canonical_path AS canonical,archived_at AS archived FROM projection_threads WHERE thread_id = ${id}`,
    );
    const canonical = await realpath(destination);
    expect(thread).toMatchObject({ path: canonical, canonical });
    expect(thread!.archived).not.toBeNull();
    const [runtime] = await h.runtime.runPromise(
      h.sql<{
        payload: string;
      }>`SELECT runtime_payload_json AS payload FROM provider_session_runtime WHERE thread_id = ${id}`,
    );
    expect(JSON.parse(runtime!.payload)).toEqual({ cwd: canonical, opaque: "keep" });
    expect(
      await h.runtime.runPromise(reconcileExternalWorktreeChanges(h.sql, h.engine, listing)),
    ).toEqual([]);
    await h.runtime.runPromise(assertSavedWorktreeIdentity(h.sql, id));
  } finally {
    await h.dispose();
  }
});

it("reports moved native history without changing its cursor, ownership, or chat path", async () => {
  const h = await worktreeFixture();
  try {
    const id = await h.addThread("retained");
    await h.runtime
      .runPromise(h.sql`INSERT INTO provider_session_runtime(thread_id,provider_name,adapter_key,status,last_seen_at,resume_cursor_json,runtime_payload_json)
      VALUES (${id},'codex','codex','stopped','fixture','{"threadId":"native","opaque":"keep"}',${JSON.stringify({ cwd: h.worktree })})`);
    const before = await h.runtime.runPromise(h.sql`SELECT * FROM provider_session_runtime`);
    await h.git(["worktree", "move", h.worktree, path.join(h.root, "agent-renamed")]);
    const listing = await h.runtime.runPromise(h.service.inventory({ cwd: h.repo }));
    const issues = await h.runtime.runPromise(
      reconcileExternalWorktreeChanges(h.sql, h.engine, listing),
    );
    expect(issues.join(" ")).toContain("provider-native history");
    expect(await h.runtime.runPromise(h.sql`SELECT * FROM provider_session_runtime`)).toEqual(
      before,
    );
    const [thread] = await h.runtime.runPromise(
      h.sql<{
        path: string;
      }>`SELECT worktree_path AS path FROM projection_threads WHERE thread_id = ${id}`,
    );
    expect(thread!.path).toBe(h.worktree);
    await expect(h.runtime.runPromise(assertProviderWorktreeIdentity(id))).rejects.toThrow(
      "unavailable",
    );
    await expect(h.runtime.runPromise(assertSavedWorktreeIdentity(h.sql, id))).rejects.toThrow(
      "unavailable",
    );
    const moved = listing.entries.find((entry) => !entry.main)!;
    await expect(
      h.runtime.runPromise(
        h.service.mutate("delete", {
          ...(await h.request()),
          path: moved.path,
        }),
      ),
    ).rejects.toThrow("saved chat");
    await access(moved.path);
    await h.runtime.runPromise(
      h.sql`UPDATE projection_threads SET worktree_device = NULL, worktree_inode = NULL WHERE thread_id = ${id}`,
    );
    await expect(h.runtime.runPromise(assertSavedWorktreeIdentity(h.sql, id))).rejects.toThrow(
      "identity is unavailable for retained native history",
    );
    expect(await h.runtime.runPromise(h.sql`SELECT * FROM provider_session_runtime`)).toEqual(
      before,
    );
  } finally {
    await h.dispose();
  }
});

it("never adopts a replacement at the old path or matches by branch alone", async () => {
  const h = await worktreeFixture();
  try {
    const id = await h.addThread("replaced");
    await h.git(["worktree", "move", h.worktree, path.join(h.root, "agent-renamed")]);
    await mkdir(h.worktree);
    await h.runtime.runPromise(
      h.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("archive-replaced"),
        threadId: id,
      }),
    );
    const listing = await h.runtime.runPromise(h.service.inventory({ cwd: h.repo }));
    expect(
      (await h.runtime.runPromise(reconcileExternalWorktreeChanges(h.sql, h.engine, listing))).join(
        " ",
      ),
    ).toContain("replaced");
    await expect(h.runtime.runPromise(assertSavedWorktreeIdentity(h.sql, id))).rejects.toThrow(
      "replaced",
    );
    await access(h.worktree);
  } finally {
    await h.dispose();
  }
});

it("reports external removal even when no linked worktrees remain", async () => {
  const h = await worktreeFixture();
  try {
    await h.addThread("missing");
    await h.git(["worktree", "remove", h.worktree]);
    const listing = await h.runtime.runPromise(h.service.inventory({ cwd: h.repo }));
    expect(listing.linkedCount).toBe(0);
    expect(
      (await h.runtime.runPromise(reconcileExternalWorktreeChanges(h.sql, h.engine, listing))).join(
        " ",
      ),
    ).toContain("missing");
  } finally {
    await h.dispose();
  }
});
