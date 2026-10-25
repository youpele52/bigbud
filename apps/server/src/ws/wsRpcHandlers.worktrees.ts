import { Effect, type Scope } from "effect";
import type {
  WorktreeContext,
  WorktreeCreate,
  WorktreeMutation,
  WorktreeSelection,
  WorktreeOperationRecovery,
} from "@bigbud/contracts/workspace/worktrees.ts";
import type { WsRpcContext } from "./wsRpcContext.ts";
import { makeWorktreeInventory, worktreeFailure } from "../git/Layers/WorktreeInventory.ts";
import { makeWorktreeLifecycle } from "../git/Layers/WorktreeLifecycle.ts";
import { runOwnedWorktreeOperation } from "./wsWorktreeOwnedOperation.ts";
import { reconcileExternalWorktreeChanges } from "../git/Layers/WorktreeExternalChanges.ts";

/** Inventory stays available remotely; lifecycle mutations are explicitly local-first. */
export function makeWsRpcWorktreeHandlers(context: WsRpcContext, worktreeScope: Scope.Scope) {
  const lifecycle = Effect.gen(function* () {
    const sql = context.worktreeSql;
    if (!sql)
      return yield* worktreeFailure("worktree", "Durable workspace storage is unavailable.");
    return makeWorktreeLifecycle({
      sql,
      git: context.git,
      engine: context.orchestrationEngine,
      worktreesDir: context.config.worktreesDir,
      providerService: context.providerService,
    });
  });
  return {
    "worktrees.operations": (input: WorktreeContext) =>
      lifecycle.pipe(Effect.flatMap((service) => service.operations(input))),
    "worktrees.recover": (input: WorktreeOperationRecovery) =>
      context.startup
        .enqueueCommand(
          runOwnedWorktreeOperation(
            worktreeScope,
            lifecycle.pipe(Effect.flatMap((service) => service.recoverOperation(input))),
          ),
        )
        .pipe(Effect.mapError((cause) => worktreeFailure(input.cwd, String(cause), cause))),
    "worktrees.list": (input: WorktreeContext) =>
      Effect.gen(function* () {
        const listing = yield* makeWorktreeInventory(context.git)(input);
        const issues = context.worktreeSql
          ? yield* reconcileExternalWorktreeChanges(
              context.worktreeSql,
              context.orchestrationEngine,
              listing,
            )
          : [];
        const [row] = context.worktreeSql
          ? yield* context.worktreeSql<{
              readonly revision: number;
            }>`SELECT COALESCE(MAX(rowid),0) AS revision FROM worktree_operations WHERE kind <> 'access'`
          : [];
        return { ...listing, revision: row?.revision ?? 0, issues };
      }).pipe(Effect.mapError((cause) => worktreeFailure(input.cwd, String(cause), cause))),
    "worktrees.create": (input: WorktreeCreate) =>
      context.startup
        .enqueueCommand(
          runOwnedWorktreeOperation(
            worktreeScope,
            lifecycle.pipe(
              Effect.flatMap((service) => service.create(input)),
              Effect.tap(() => context.refreshGitStatus(input.cwd)),
            ),
          ),
        )
        .pipe(Effect.mapError((cause) => worktreeFailure(input.cwd, String(cause), cause))),
    "worktrees.delete": (input: WorktreeMutation) =>
      context.startup
        .enqueueCommand(
          runOwnedWorktreeOperation(
            worktreeScope,
            lifecycle.pipe(Effect.flatMap((service) => service.mutate("delete", input))),
          ),
        )
        .pipe(Effect.mapError((cause) => worktreeFailure(input.cwd, String(cause), cause))),
    "worktrees.select": (input: WorktreeSelection) =>
      context.startup
        .enqueueCommand(lifecycle.pipe(Effect.flatMap((service) => service.select(input))))
        .pipe(Effect.mapError((cause) => worktreeFailure(input.cwd, String(cause), cause))),
  };
}
