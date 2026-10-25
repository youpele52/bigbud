import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, lstat } from "node:fs/promises";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { WorktreeCreate } from "@bigbud/contracts/workspace/worktrees.ts";
import type { GitCoreShape } from "../Services/GitCore.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import { captureWorktreePathIdentity } from "../../retention/worktreeRuntimeLease.ts";
import { makeWorktreeInventory, worktreeFailure } from "./WorktreeInventory.ts";
import {
  makeWorktreeReservations,
  operationColumns,
  type WorktreeOperationRow,
} from "./WorktreeReservations.ts";
import { worktreeBasename } from "./WorktreeLifecycle.preflight.ts";
import { executeWorktreeGit, proveRejectedCreation } from "./WorktreeLifecycle.outcomes.ts";

/** The empty directory's durable inode proves ownership after an add acknowledgement is lost. */
export function makeWorktreeCreation(input: {
  sql: SqlClient.SqlClient;
  git: GitCoreShape;
  engine: OrchestrationEngineShape;
  worktreesDir: string;
}) {
  const { sql, git, engine } = input;
  const inventory = makeWorktreeInventory(git);
  const reservations = makeWorktreeReservations(sql);
  const failure = (cwd: string, cause: unknown) => worktreeFailure(cwd, String(cause), cause);
  const run = (cwd: string, args: string[], onSettled?: (code: number) => void) =>
    executeWorktreeGit(git, cwd, args, onSettled);
  const find = (id: string) =>
    sql.unsafe<WorktreeOperationRow>(
      `SELECT ${operationColumns} FROM worktree_operations WHERE operation_id = ?`,
      [id],
    );
  const exists = (target: string) =>
    Effect.tryPromise({
      try: async () => {
        try {
          await lstat(target);
          return true;
        } catch (cause) {
          if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")
            return false;
          throw cause;
        }
      },
      catch: (cause) => failure(target, cause),
    });
  const resume = (saved: WorktreeOperationRow) => {
    let dispatchedHere = false,
      settledFailure = false;
    return Effect.gen(function* () {
      let operation = saved;
      if (operation.phase === "completed")
        return { path: operation.destination, branch: operation.branch! };
      if (operation.phase === "rejected")
        return yield* worktreeFailure(
          operation.cwd,
          "Creation was rejected; refresh before trying another operation.",
        );
      if (operation.device === -1) {
        if (operation.phase !== "prepared" || (yield* exists(operation.destination)))
          return yield* worktreeFailure(
            operation.cwd,
            "Creation directory ownership is unconfirmed. Nothing was adopted or removed.",
          );
        const parent = yield* Effect.tryPromise({
          try: () => captureWorktreePathIdentity(operation.parentPath!),
          catch: (cause) => failure(operation.cwd, cause),
        });
        if (parent.device !== operation.parentDevice || parent.inode !== operation.parentInode)
          return yield* worktreeFailure(operation.cwd, "Managed worktree root identity changed.");
        yield* Effect.tryPromise({
          try: () => mkdir(operation.destination),
          catch: (cause) => failure(operation.cwd, cause),
        });
        const identity = yield* Effect.tryPromise({
          try: () => captureWorktreePathIdentity(operation.destination),
          catch: (cause) => failure(operation.cwd, cause),
        });
        yield* sql`UPDATE worktree_operations SET device = ${identity.device}, inode = ${identity.inode}, canonical_path = ${identity.canonicalPath} WHERE operation_id = ${operation.operationId} AND phase = 'prepared'`;
        operation = {
          ...operation,
          device: identity.device,
          inode: identity.inode,
          canonical: identity.canonicalPath,
        };
      }
      const currentIdentity = yield* Effect.tryPromise({
        try: () => captureWorktreePathIdentity(operation.destination),
        catch: (cause) => failure(operation.cwd, cause),
      });
      if (currentIdentity.device !== operation.device || currentIdentity.inode !== operation.inode)
        return yield* worktreeFailure(
          operation.cwd,
          "Creation directory identity changed. Nothing was adopted or removed.",
        );
      let listing = yield* inventory({ cwd: operation.cwd });
      let entry = listing.entries.find((candidate) => candidate.path === operation.destination);
      if (!entry) {
        if (operation.phase !== "prepared")
          return yield* worktreeFailure(
            operation.cwd,
            "Worktree add outcome is unconfirmed; no add was repeated.",
          );
        const claimed =
          yield* sql`UPDATE worktree_operations SET phase = 'dispatched' WHERE operation_id = ${operation.operationId} AND phase = 'prepared' RETURNING operation_id`;
        if (claimed.length !== 1)
          return yield* worktreeFailure(operation.cwd, "Creation is already dispatched.");
        dispatchedHere = true;
        // The resolved base commit is durable; branch movement cannot change the intended starting point.
        yield* run(
          operation.cwd,
          [
            "worktree",
            "add",
            "-b",
            operation.branch!,
            "--",
            operation.destination,
            operation.head!,
          ],
          (code) => {
            settledFailure = code !== 0;
          },
        );
        listing = yield* inventory({ cwd: operation.cwd });
        entry = listing.entries.find((candidate) => candidate.path === operation.destination);
      }
      if (
        !entry ||
        entry.identity !== `${operation.device}:${operation.inode}` ||
        entry.branch !== operation.branch ||
        entry.head !== operation.head
      )
        return yield* worktreeFailure(
          operation.cwd,
          "Created worktree identity, branch or commit disagrees with its durable request.",
        );
      yield* sql`UPDATE worktree_operations SET phase = 'completed', error = NULL WHERE operation_id = ${operation.operationId}`;
      return { path: entry.path, branch: entry.branch! };
    }).pipe(
      Effect.mapError((cause) => failure(saved.cwd, cause)),
      Effect.tapError((cause) =>
        Effect.gen(function* () {
          const [current] = yield* find(saved.operationId);
          const rejected =
            current?.phase === "prepared" ||
            (current &&
              dispatchedHere &&
              settledFailure &&
              (yield* proveRejectedCreation(git, current)));
          const detail = rejected
            ? `${String(cause)} No registered worktree was adopted; any branch or reserved folder was retained.`
            : String(cause);
          yield* sql`UPDATE worktree_operations SET phase = ${rejected ? "rejected" : "recovery-required"}, error = ${detail} WHERE operation_id = ${saved.operationId} AND phase NOT IN ('completed','rejected')`;
        }).pipe(Effect.catch(() => Effect.void)),
      ),
    );
  };

  const create = (request: WorktreeCreate) =>
    Effect.gen(function* () {
      if (request.executionTargetId && request.executionTargetId !== "local")
        return yield* worktreeFailure(
          request.cwd,
          "Explicit creation is local-first; use the existing supported remote creation workflow.",
        );
      const digest = createHash("sha256")
        .update(
          JSON.stringify([
            "create",
            request.cwd,
            request.executionTargetId ?? "local",
            request.name,
            request.branch,
            request.newBranch,
          ]),
        )
        .digest("hex");
      const [saved] = yield* find(request.operationId);
      if (saved) {
        if (saved.kind !== "create" || saved.requestDigest !== digest)
          return yield* worktreeFailure(
            request.cwd,
            "Operation ID conflicts with its original request.",
          );
        return yield* resume(saved);
      }
      const name = yield* Effect.try({
        try: () => worktreeBasename(request.name),
        catch: (cause) => failure(request.cwd, cause),
      });
      const listing = yield* inventory(request);
      const main = listing.entries.find((entry) => entry.main && !entry.bare);
      if (!main) return yield* worktreeFailure(request.cwd, "A main checkout is required.");
      if (
        !request.branch ||
        request.branch.startsWith("-") ||
        !request.newBranch ||
        request.newBranch.startsWith("-")
      )
        return yield* worktreeFailure(request.cwd, "Choose a valid base and new branch name.");
      yield* run(main.path, ["check-ref-format", "--branch", request.newBranch]);
      const branch = yield* git.execute({
        cwd: main.path,
        args: ["show-ref", "--verify", "--quiet", `refs/heads/${request.newBranch}`],
        operation: "worktree.lifecycle",
        allowNonZeroExit: true,
      });
      if (branch.code === 0)
        return yield* worktreeFailure(
          request.cwd,
          "The new branch already exists. Choose a different branch; no worktree operation was started.",
        );
      if (branch.code !== 1 || branch.stdoutTruncated)
        return yield* worktreeFailure(
          request.cwd,
          "Could not verify whether the new branch exists.",
        );
      const head = (yield* run(main.path, [
        "rev-parse",
        "--verify",
        `${request.branch}^{commit}`,
      ])).trim();
      const root = path.join(input.worktreesDir, path.basename(main.path));
      yield* Effect.tryPromise({
        try: () => mkdir(root, { recursive: true }),
        catch: (cause) => failure(request.cwd, cause),
      });
      const parent = yield* Effect.tryPromise({
        try: () => captureWorktreePathIdentity(root),
        catch: (cause) => failure(request.cwd, cause),
      });
      const destination = path.join(parent.canonicalPath, name);
      if (yield* exists(destination))
        return yield* worktreeFailure(
          request.cwd,
          "A folder with this name already exists. Nothing was adopted or removed.",
        );
      if (!engine.withWorkspaceBarrier)
        return yield* worktreeFailure(request.cwd, "Workspace admission is unavailable.");
      yield* engine.withWorkspaceBarrier(
        sql.withTransaction(
          Effect.gen(function* () {
            if (
              (yield* reservations.pending()).some(
                (other) =>
                  other.repository === listing.repository ||
                  reservations.overlaps(other, destination),
              )
            )
              return yield* worktreeFailure(
                request.cwd,
                "Another operation owns this repository or destination.",
              );
            yield* sql`INSERT INTO worktree_operations(operation_id,request_digest,kind,repository,cwd,source_path,destination_path,canonical_path,device,inode,parent_path,parent_device,parent_inode,branch,head,phase,created_at)
        VALUES (${request.operationId},${digest},'create',${listing.repository},${main.path},${destination},${destination},${destination},-1,-1,${parent.canonicalPath},${parent.device},${parent.inode},${request.newBranch},${head},'prepared',${new Date().toISOString()})`;
          }),
        ),
      );
      return yield* resume((yield* find(request.operationId))[0]!);
    }).pipe(Effect.mapError((cause) => failure(request.cwd, cause)));
  return { create, resume };
}
