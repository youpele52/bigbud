import path from "node:path";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type {
  WorktreeMutation,
  WorktreeOperationResult,
} from "@bigbud/contracts/workspace/worktrees.ts";
import type { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";
import type { GitCoreShape } from "../Services/GitCore.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import { captureWorktreePathIdentity } from "../../retention/worktreeRuntimeLease.ts";
import { makeWorktreeInventory, worktreeFailure } from "./WorktreeInventory.ts";
import {
  makeWorktreeReservations,
  operationColumns,
  type WorktreeOperationRow,
} from "./WorktreeReservations.ts";
import { captureWorktreePreflight } from "./WorktreeLifecycle.preflight.snapshot.ts";
import { canonicalWorktreePath } from "./WorktreeReferences.ts";
import { makeWorktreeSelection } from "./WorktreeLifecycle.selection.ts";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import { assertNoLiveWorktreeProvider } from "./WorktreeProviderSafety.ts";
import { makeWorktreeCreation } from "./WorktreeCreation.ts";
import { makeWorktreeOperations } from "./WorktreeOperations.ts";
import {
  executeWorktreeGit,
  worktreeIdentityAt as identityAt,
  readWorktreeStatus,
  proveUnchangedWorktree,
} from "./WorktreeLifecycle.outcomes.ts";

/** All filesystem work occurs after a durable reservation; metadata changes remain event sourced. */
export function makeWorktreeLifecycle(input: {
  readonly sql: SqlClient.SqlClient;
  readonly git: GitCoreShape;
  readonly engine: OrchestrationEngineShape;
  readonly worktreesDir: string;
  readonly providerService?: Pick<ProviderServiceShape, "listSessionsForReconciliation">;
}) {
  const { sql, git, engine } = input;
  const inventory = makeWorktreeInventory(git);
  const reservations = makeWorktreeReservations(sql);
  const failure = (cwd: string, cause: unknown) =>
    worktreeFailure(cwd, cause instanceof Error ? cause.message : String(cause), cause);
  const find = (id: string) =>
    sql.unsafe<WorktreeOperationRow>(
      `SELECT ${operationColumns} FROM worktree_operations WHERE operation_id = ?`,
      [id],
    );
  const barrier = <A, E>(effect: Effect.Effect<A, E>) =>
    engine.withWorkspaceBarrier
      ? engine.withWorkspaceBarrier(effect)
      : Effect.fail(worktreeFailure("worktree", "Workspace preparation barrier is unavailable."));
  const phase = (id: string, value: string) =>
    sql`UPDATE worktree_operations SET phase = ${value}, error = NULL WHERE operation_id = ${id}`;
  const run = (cwd: string, args: string[], onSettled?: (code: number) => void) =>
    executeWorktreeGit(git, cwd, args, onSettled);

  const resume = (
    operation: WorktreeOperationRow,
  ): Effect.Effect<WorktreeOperationResult, GitCommandError> => {
    let dispatchedHere = false,
      settledFailure = false;
    let previousStatus: string | undefined;
    return Effect.gen(function* () {
      if (operation.phase === "completed")
        return {
          operationId: operation.operationId,
          path: operation.destination,
          status: "completed" as const,
        };
      if (operation.phase === "rejected")
        return yield* worktreeFailure(
          operation.cwd,
          "This operation was rejected. Refresh the inventory before trying a new operation.",
        );
      if (operation.kind !== "delete")
        return yield* worktreeFailure(
          operation.cwd,
          "Legacy worktree relocation requires manual review. No filesystem or provider history changes were attempted; its reservation is retained.",
        );
      const listing = yield* inventory({ cwd: operation.cwd });
      const expectedIdentity = `${operation.device}:${operation.inode}`;
      const source = listing.entries.find((entry) => entry.path === operation.source);
      let removed =
        !source &&
        !listing.entries.some((entry) => entry.identity === expectedIdentity) &&
        !(yield* identityAt(operation.source));
      if (!removed) {
        if (operation.phase !== "prepared")
          return yield* worktreeFailure(
            operation.cwd,
            "Worktree outcome is unconfirmed; no filesystem operation was retried. Workspace remains reserved for recovery.",
          );
        yield* assertNoLiveWorktreeProvider(input.providerService, operation.canonical);
        if (
          !source ||
          source.identity !== expectedIdentity ||
          source.head !== operation.head ||
          source.branch !== operation.branch ||
          source.main ||
          source.locked ||
          source.prunable ||
          source.bare
        )
          return yield* worktreeFailure(
            operation.cwd,
            "Worktree identity or Git state changed before dispatch.",
          );
        const safety = yield* captureWorktreePreflight(sql, operation, input.worktreesDir);
        yield* barrier(sql.withTransaction(safety.verify));
        const commit = yield* run(operation.source, ["rev-parse", "--verify", "HEAD^{commit}"]);
        if (commit.trim() !== operation.head)
          return yield* worktreeFailure(
            operation.cwd,
            "Worktree commit changed before dispatch. Refresh and try again.",
          );
        previousStatus = yield* readWorktreeStatus(git, operation.source);
        if (previousStatus.length)
          return yield* worktreeFailure(
            operation.cwd,
            "Worktree contains tracked, untracked or ignored files. Nothing was deleted.",
          );
        if (
          (yield* identityAt(operation.source)) !== expectedIdentity ||
          !operation.parentPath ||
          (yield* identityAt(operation.parentPath)) !==
            `${operation.parentDevice}:${operation.parentInode}`
        )
          return yield* worktreeFailure(
            operation.cwd,
            "Worktree or parent identity changed before dispatch.",
          );
        const claimed =
          yield* sql`UPDATE worktree_operations SET phase = 'dispatched' WHERE operation_id = ${operation.operationId} AND phase = 'prepared' RETURNING operation_id`;
        if (claimed.length !== 1)
          return yield* worktreeFailure(
            operation.cwd,
            "This operation is already dispatched; no filesystem work was repeated.",
          );
        dispatchedHere = true;
        yield* run(operation.cwd, ["worktree", "remove", "--", operation.source], (code) => {
          settledFailure = code !== 0;
        });
        const verified = yield* inventory({ cwd: operation.cwd });
        removed =
          !verified.entries.some((candidate) => candidate.path === operation.source) &&
          !verified.entries.some((candidate) => candidate.identity === expectedIdentity) &&
          !(yield* identityAt(operation.source));
        if (!removed)
          return yield* worktreeFailure(
            operation.cwd,
            "Git registration and filesystem outcome disagree; workspace remains reserved.",
          );
      }
      yield* phase(operation.operationId, "completed");
      return {
        operationId: operation.operationId,
        path: operation.destination,
        status: "completed" as const,
      };
    }).pipe(
      Effect.mapError((cause) => failure(operation.cwd, cause)),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const [current] = yield* find(operation.operationId);
          const unchanged =
            dispatchedHere && settledFailure && previousStatus !== undefined
              ? yield* proveUnchangedWorktree(git, operation, previousStatus)
              : false;
          yield* sql`UPDATE worktree_operations SET phase = ${operation.kind === "delete" && (current?.phase === "prepared" || unchanged) ? "rejected" : "recovery-required"}, error = ${String(cause)} WHERE operation_id = ${operation.operationId} AND phase NOT IN ('completed','rejected')`;
          return yield* cause;
        }),
      ),
      Effect.mapError((cause) => failure(operation.cwd, cause)),
    );
  };

  const mutate = (kind: "delete", request: WorktreeMutation) =>
    Effect.gen(function* () {
      if (request.executionTargetId && request.executionTargetId !== "local")
        return yield* worktreeFailure(
          request.cwd,
          "Remote deletion is not supported; no local operation was attempted.",
        );
      const digest = createHash("sha256")
        .update(
          JSON.stringify([
            kind,
            request.cwd,
            request.executionTargetId ?? "local",
            request.path,
            request.expectedIdentity,
            request.expectedHead,
            request.expectedBranch,
            null, // Preserve the request digest of previously recorded deletion operations.
          ]),
        )
        .digest("hex");
      const [existing] = yield* find(request.operationId);
      if (existing) {
        if (existing.requestDigest !== digest)
          return yield* worktreeFailure(
            request.cwd,
            "Operation ID conflicts with its original request.",
          );
        return yield* resume(existing);
      }
      const listing = yield* inventory(request);
      const requestedPath = yield* canonicalWorktreePath(request.path);
      const entry = listing.entries.find((candidate) => candidate.path === requestedPath);
      if (
        !entry ||
        entry.main ||
        entry.bare ||
        entry.locked ||
        entry.prunable ||
        !entry.identity ||
        entry.identity !== request.expectedIdentity ||
        entry.head !== request.expectedHead ||
        entry.branch !== request.expectedBranch
      )
        return yield* worktreeFailure(
          request.cwd,
          "Worktree identity or Git state changed. Refresh before trying again; main/locked/unavailable worktrees cannot be changed.",
        );
      const destination = entry.path;
      const identity = yield* Effect.tryPromise({
        try: () => captureWorktreePathIdentity(request.path),
        catch: (cause) => failure(request.cwd, cause),
      });
      const parentIdentity = yield* Effect.tryPromise({
        try: () => captureWorktreePathIdentity(path.dirname(entry.path)),
        catch: (cause) => failure(request.cwd, cause),
      });
      const operation: WorktreeOperationRow = {
        operationId: request.operationId,
        requestDigest: digest,
        kind,
        cwd: listing.entries.find((candidate) => candidate.main)?.path ?? request.cwd,
        repository: listing.repository,
        source: entry.path,
        destination,
        canonical: identity.canonicalPath,
        device: identity.device,
        inode: identity.inode,
        parentPath: parentIdentity.canonicalPath,
        parentDevice: parentIdentity.device,
        parentInode: parentIdentity.inode,
        branch: entry.branch,
        head: entry.head,
        phase: "prepared",
        error: null,
      };
      const safety = yield* captureWorktreePreflight(sql, operation, input.worktreesDir);
      yield* barrier(
        sql.withTransaction(
          Effect.gen(function* () {
            const pending = yield* reservations.pending();
            if (
              pending.some(
                (other) =>
                  other.repository === operation.repository ||
                  reservations.overlaps(other, operation.canonical) ||
                  reservations.overlaps(other, destination),
              )
            )
              return yield* worktreeFailure(
                request.cwd,
                "Another operation owns this worktree or destination.",
              );
            yield* safety.verify;
            yield* sql`INSERT INTO worktree_operations (operation_id,request_digest,kind,repository,cwd,source_path,destination_path,canonical_path,device,inode,parent_path,parent_device,parent_inode,branch,head,phase,created_at)
        VALUES (${operation.operationId},${digest},${kind},${operation.repository},${operation.cwd},${operation.source},${destination},${identity.canonicalPath},${identity.device},${identity.inode},${parentIdentity.canonicalPath},${parentIdentity.device},${parentIdentity.inode},${entry.branch},${entry.head},'prepared',${new Date().toISOString()})`;
          }),
        ),
      );
      return yield* resume(operation);
    }).pipe(Effect.mapError((cause) => failure(request.cwd, cause)));

  const select = makeWorktreeSelection(input);
  const creation = makeWorktreeCreation(input);
  const diagnostics = makeWorktreeOperations(sql, git, (operation) =>
    operation.kind === "create"
      ? creation.resume(operation).pipe(Effect.asVoid)
      : resume(operation).pipe(Effect.asVoid),
  );

  const recover = Effect.gen(function* () {
    for (const operation of yield* reservations.pending())
      if (operation.kind !== "access")
        yield* (
          operation.kind === "create"
            ? creation.resume(operation).pipe(Effect.asVoid)
            : resume(operation).pipe(Effect.asVoid)
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("worktree remains fenced for recovery", {
              operationId: operation.operationId,
              cause: String(cause),
            }),
          ),
        );
  });
  return { inventory, mutate, select, create: creation.create, recover, ...diagnostics };
}
