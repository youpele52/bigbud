import path from "node:path";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { WorktreeOperationRow } from "./WorktreeReservations.ts";
import {
  canonicalWorktreePath,
  listWorktreeReferences,
  assertInactiveWorktreeThread,
  assertNoRetainedWorktreeLocation,
  type WorktreePathResolver,
} from "./WorktreeReferences.ts";
import { recordedWorktreePathsOverlap } from "../../deletion/Layers/ThreadDeletion.worktreePaths.ts";
import { worktreeFailure } from "./WorktreeInventory.ts";

/** Folder names never permit traversal, arbitrary relocation, or branch sanitization. */
export function worktreeBasename(name: string): string {
  if (
    !name ||
    name !== name.trim() ||
    name.length > 120 ||
    /[\\/<>:"|?*]/u.test(name) ||
    Array.from(name).some((character) => character.charCodeAt(0) < 32) ||
    /[. ]$/u.test(name) ||
    name === "." ||
    name === ".." ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
    throw new Error("Enter a folder name without separators, traversal or reserved characters.");
  return name;
}

export function preflightWorktreeOperation(
  sql: SqlClient.SqlClient,
  operation: WorktreeOperationRow,
  managedRoot: string,
  resolve: WorktreePathResolver = canonicalWorktreePath,
) {
  return Effect.gen(function* () {
    const fail = (detail: string) => worktreeFailure(operation.cwd, detail);
    if (operation.kind !== "delete")
      return yield* fail(
        "Only deletion uses this workspace preflight; legacy relocation requires manual review.",
      );
    const projects = yield* sql<{
      readonly root: string;
    }>`SELECT workspace_root AS root FROM projection_projects
      WHERE workspace_execution_target_id = 'local' AND deleted_at IS NULL AND workspace_root IS NOT NULL`;
    for (const project of projects) {
      const root = yield* resolve(project.root);
      const relative = path.relative(operation.canonical, root);
      if (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..")
        return yield* fail(
          "A saved project root depends on this worktree. It cannot be deleted here.",
        );
    }
    const leases = yield* sql<{
      readonly target: string;
      readonly device: number;
      readonly inode: number;
    }>`
      SELECT canonical_path AS target, device, inode FROM worktree_runtime_leases
      UNION ALL SELECT canonical_path AS target, device, inode FROM purge_resource_claims WHERE resource_kind = 'managed-worktree'`;
    if (
      leases.some(
        (lease) =>
          recordedWorktreePathsOverlap(lease.target, operation.canonical) ||
          (lease.device === operation.device && lease.inode === operation.inode),
      )
    )
      return yield* fail(
        "This worktree has a runtime lease or is claimed by cleanup. Wait for it to settle.",
      );
    const cleanups = yield* sql<{ readonly resource: string }>`SELECT resource_json AS resource
      FROM direct_resource_cleanup_worktrees WHERE state <> 'completed'`;
    for (const cleanup of cleanups) {
      const resource = yield* Effect.try({
        try: () => JSON.parse(cleanup.resource) as { relativePath: string },
        catch: () => fail("Cleanup ownership could not be verified."),
      });
      if (
        recordedWorktreePathsOverlap(
          path.resolve(managedRoot, resource.relativePath),
          operation.canonical,
        )
      )
        return yield* fail("An unfinished cleanup owns this worktree.");
    }
    const recipes = yield* sql<{
      readonly target: string | null;
      readonly project: string;
      readonly parent: string;
    }>`
      SELECT deterministic_worktree_path AS target, project_cwd AS project, parent_command_id AS parent
      FROM orchestration_bootstrap_recipes WHERE execution_target_id IS NULL OR execution_target_id = 'local'`;
    for (const recipe of recipes) {
      if (
        !(recipe.target && recordedWorktreePathsOverlap(recipe.target, operation.canonical)) &&
        !recordedWorktreePathsOverlap(recipe.project, operation.canonical)
      )
        continue;
      const accepted =
        yield* sql`SELECT 1 FROM orchestration_command_receipts WHERE command_id = ${recipe.parent} AND status = 'accepted'`;
      if (!accepted.length) return yield* fail("An unfinished bootstrap owns this worktree.");
    }
    const references = yield* listWorktreeReferences(sql, operation.canonical, resolve, operation);
    for (const reference of references)
      yield* assertInactiveWorktreeThread(sql, reference.threadId);
    if (references.length)
      return yield* fail(
        `This worktree is referenced by ${references.length} saved chat(s), including archived chats. Switch or remove those references first.`,
      );
    const bindings = yield* sql<{
      readonly cwd: string;
    }>`SELECT json_extract(runtime_payload_json,'$.cwd') AS cwd
      FROM provider_session_runtime WHERE workspace_execution_target_id = 'local' AND json_extract(runtime_payload_json,'$.cwd') IS NOT NULL`;
    for (const binding of bindings) {
      const cwd = yield* resolve(binding.cwd);
      if (!recordedWorktreePathsOverlap(cwd, operation.canonical)) continue;
      return yield* fail(
        "An independent provider binding still references this worktree. Nothing was deleted.",
      );
    }
    yield* assertNoRetainedWorktreeLocation(sql, operation.canonical, resolve);
    return references;
  });
}
