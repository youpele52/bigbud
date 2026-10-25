import path from "node:path";
import { Effect } from "effect";
import type { GitRemoveWorktreeInput } from "@bigbud/contracts/workspace/git.inputs.ts";
import type { WsRpcContext } from "./wsRpcContext.ts";
import { makeWorktreeLifecycle } from "../git/Layers/WorktreeLifecycle.ts";
import { makeWorktreeInventory, worktreeFailure } from "../git/Layers/WorktreeInventory.ts";

/** The legacy public removal RPC must not bypass the picker safeguards. */
export function removePublicWorktree(context: WsRpcContext, request: GitRemoveWorktreeInput) {
  return Effect.gen(function* () {
    if (request.force)
      return yield* worktreeFailure(request.cwd, "Forced worktree deletion is not available.");
    const sql = context.worktreeSql;
    if (!sql)
      return yield* worktreeFailure(
        request.cwd,
        "Durable workspace storage is unavailable; nothing was removed.",
      );
    const listing = yield* makeWorktreeInventory(context.git)(request);
    const entry = listing.entries.find((candidate) => candidate.path === request.path);
    if (!entry || entry.main || entry.bare || entry.locked || entry.prunable)
      return yield* worktreeFailure(
        request.cwd,
        "Main, locked or unavailable worktrees cannot be deleted.",
      );
    if (listing.local) {
      if (!entry.identity)
        return yield* worktreeFailure(request.cwd, "Worktree identity is unavailable.");
      yield* makeWorktreeLifecycle({
        sql,
        git: context.git,
        engine: context.orchestrationEngine,
        worktreesDir: context.config.worktreesDir,
        providerService: context.providerService,
      }).mutate("delete", {
        ...request,
        operationId: request.operationId ?? crypto.randomUUID(),
        expectedIdentity: entry.identity,
        expectedHead: entry.head,
        expectedBranch: entry.branch,
      });
      return;
    }
    // Preserve the existing target-routed remote mutation and its durable action identity.
    const references = yield* sql<{
      readonly target: string;
    }>`SELECT worktree_path AS target FROM projection_threads
      WHERE workspace_execution_target_id = ${request.executionTargetId ?? "local"} AND worktree_path IS NOT NULL`;
    if (
      references.some(
        (reference) =>
          reference.target === request.path ||
          path.posix.relative(request.path, reference.target).split("/")[0] !== "..",
      )
    )
      return yield* worktreeFailure(
        request.cwd,
        "Saved chats still reference this remote worktree.",
      );
    const dirty = yield* context.git.execute({
      ...request,
      cwd: request.path,
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"],
      operation: "worktree.delete.preflight",
    });
    if (dirty.code !== 0 || dirty.stdoutTruncated || dirty.stdout.length)
      return yield* worktreeFailure(
        request.cwd,
        "Remote worktree cleanliness could not be established. Nothing was deleted.",
      );
    yield* context.git.removeWorktree({ ...request, force: false });
  }).pipe(Effect.mapError((cause) => worktreeFailure(request.cwd, String(cause), cause)));
}
