import path from "node:path";
import { mkdir, realpath, symlink } from "node:fs/promises";
import { expect, it } from "vitest";
import { worktreeFixture } from "./WorktreeLifecycle.test.helpers.ts";
import { canonicalWorktreePath } from "./WorktreeReferences.ts";
import { listRetainedWorktreeProviderContexts } from "./WorktreeProviderContexts.ts";

it("discovers orphaned native owners beyond the first page, including aliases and descendants", async () => {
  const h = await worktreeFixture();
  try {
    const alias = path.join(h.root, "alias");
    await symlink(h.worktree, alias, "dir");
    await mkdir(path.join(h.worktree, "child"));
    for (let i = 0; i < 105; i++) {
      const location = i === 104 ? path.join(alias, "child") : path.join(h.root, "unrelated");
      await h.runtime
        .runPromise(h.sql`INSERT INTO provider_turn_admissions(namespace,owner_thread_id,request_message_id,binding_json,fingerprint,native_admission_id,turn_id,state,created_at,updated_at)
        VALUES ('foreground',${`unloaded-${i}`},'request',${JSON.stringify({ provider: "opencodeV2", location, nativeSessionId: `native-${i}`, storageIdentity: "fixture-storage", workspaceTargetId: "local" })},'fixture','fixture','fixture','terminal','fixture','fixture')`);
    }
    const found = await h.runtime.runPromise(
      listRetainedWorktreeProviderContexts(h.sql, h.worktree, canonicalWorktreePath),
    );
    expect(found).toMatchObject([
      { owner: "unloaded-104", canonicalLocation: await realpath(path.join(h.worktree, "child")) },
    ]);
    await h.runtime.runPromise(
      h.sql`UPDATE provider_turn_admissions SET binding_json = ${JSON.stringify({ provider: "opencodeV2", location: alias, nativeSessionId: "native-104", storageIdentity: "fixture-storage", workspaceTargetId: "local" })} WHERE owner_thread_id = 'unloaded-104'`,
    );
    const aliased = await h.runtime.runPromise(
      listRetainedWorktreeProviderContexts(h.sql, h.worktree, canonicalWorktreePath),
    );
    expect(aliased).toMatchObject([
      {
        kind: "admission",
        owner: "unloaded-104",
        canonicalLocation: await realpath(h.worktree),
      },
    ]);
  } finally {
    await h.dispose();
  }
});

it("includes stopped runtime identity with no saved chat and excludes explicit remote storage", async () => {
  const h = await worktreeFixture();
  try {
    await h.runtime
      .runPromise(h.sql`INSERT INTO provider_session_runtime(thread_id,provider_name,adapter_key,status,last_seen_at,resume_cursor_json,runtime_payload_json)
      VALUES ('orphan-native','codex','codex','stopped','fixture','{"threadId":"retained-id"}',${JSON.stringify({ cwd: h.worktree })})`);
    await h.runtime
      .runPromise(h.sql`INSERT INTO opencode_v2_shared_bindings(thread_id,material_json,state,revision)
      VALUES ('remote-only',${JSON.stringify({ directory: h.worktree, workspaceTargetId: "ssh:fixture" })},'verified',0)`);
    const found = await h.runtime.runPromise(
      listRetainedWorktreeProviderContexts(h.sql, h.worktree, canonicalWorktreePath),
    );
    expect(found).toMatchObject([
      {
        kind: "runtime",
        owner: "orphan-native",
        provider: "codex",
      },
    ]);
    await expect(
      h.runtime.runPromise(h.service.mutate("delete", await h.request())),
    ).rejects.toThrow();
    expect((await h.git(["worktree", "list", "--porcelain"])).stdout).toContain(
      path.basename(h.worktree),
    );
  } finally {
    await h.dispose();
  }
});

it("rejects unknown location/identity evidence instead of silently omitting an owner", async () => {
  const h = await worktreeFixture();
  try {
    await h.runtime.runPromise(
      h.sql`INSERT INTO opencode_v2_shared_bindings(thread_id,material_json,state,revision) VALUES ('uncertain','{}','verified',0)`,
    );
    await expect(
      h.runtime.runPromise(
        listRetainedWorktreeProviderContexts(h.sql, h.worktree, canonicalWorktreePath),
      ),
    ).rejects.toThrow("could not be verified");
  } finally {
    await h.dispose();
  }
});
