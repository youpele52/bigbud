import * as nodeFs from "node:fs/promises";

import { CheckpointRef } from "@bigbud/contracts";
import { Data, Effect } from "effect";

import type { CheckpointStoreShape } from "../../checkpointing/Services/CheckpointStore.ts";
import type { PurgeJob } from "../../persistence/Services/PurgeJobRepository.ts";
import type { ThreadAssetRow } from "./EntityPurge.assets.ts";
import type { makeEntityPurgeSql } from "./EntityPurge.sql.ts";

class WorkspaceInspectionError extends Data.TaggedError("WorkspaceInspectionError")<{
  readonly cause: unknown;
}> {}

export function makeEntityPurgeCheckpointOps(input: {
  readonly checkpointStore: CheckpointStoreShape;
  readonly queries: ReturnType<typeof makeEntityPurgeSql>;
}) {
  const workspaceExists = (cwd: string) =>
    Effect.tryPromise({
      try: () => nodeFs.lstat(cwd),
      catch: (cause) => new WorkspaceInspectionError({ cause }),
    }).pipe(
      Effect.map(() => true),
      Effect.catch((error) => {
        const cause = error.cause;
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          (cause.code === "ENOENT" || cause.code === "ENOTDIR")
        ) {
          return Effect.succeed(false);
        }
        return Effect.fail(error);
      }),
    );

  const captureCheckpointRefs = Effect.fn("EntityPurge.captureCheckpointRefs")(function* (
    job: PurgeJob,
    rows: ReadonlyArray<ThreadAssetRow>,
  ) {
    if ((yield* input.queries.listCheckpointRefs(job.jobId)).length > 0) return;
    const workspaces = new Set(
      rows.flatMap((row) =>
        (row.worktreePath ?? row.workspaceRoot) ? [row.worktreePath ?? row.workspaceRoot!] : [],
      ),
    );
    if (workspaces.size > 1) {
      return yield* Effect.fail(new Error("thread checkpoint workspace is ambiguous"));
    }
    const workspaceCwd = [...workspaces][0] ?? "";
    const workspacePresent = workspaceCwd.length > 0 && (yield* workspaceExists(workspaceCwd));
    const isGit = workspacePresent
      ? yield* input.checkpointStore.isGitRepository(workspaceCwd)
      : false;
    const identity = isGit
      ? yield* input.checkpointStore.captureRepositoryIdentity(workspaceCwd)
      : null;
    const checkpointRefs = identity
      ? yield* input.checkpointStore.listThreadCheckpointRefs({
          cwd: workspaceCwd,
          threadId: job.entityId,
          identity,
        })
      : [];
    yield* input.queries.replaceCheckpointRefs({
      jobId: job.jobId,
      workspaceCwd: workspacePresent ? workspaceCwd : "",
      repositoryKind: workspacePresent ? (isGit ? "git" : "non-git") : null,
      workspaceCanonicalPath: identity?.workspace.canonicalPath ?? null,
      workspaceDevice: identity?.workspace.device ?? null,
      workspaceInode: identity?.workspace.inode ?? null,
      gitCommonDirCanonicalPath: identity?.gitCommonDir.canonicalPath ?? null,
      gitCommonDirDevice: identity?.gitCommonDir.device ?? null,
      gitCommonDirInode: identity?.gitCommonDir.inode ?? null,
      checkpointRefs: checkpointRefs.map(String),
    });
  });

  const deleteCheckpointRefs = Effect.fn("EntityPurge.deleteCheckpointRefs")(function* (
    job: PurgeJob,
  ) {
    if (job.entityKind !== "thread") return;
    const rows = yield* input.queries.listCheckpointRefs(job.jobId);
    if (rows.length === 0) {
      return yield* Effect.fail(new Error("checkpoint ref set was not captured safely"));
    }
    const cwd = rows[0]!.workspaceCwd;
    const first = rows[0]!;
    if (first.verifiedAt !== null && !(yield* workspaceExists(cwd))) return;
    const refs = rows.flatMap((row) =>
      row.checkpointRef === null ? [] : [CheckpointRef.makeUnsafe(row.checkpointRef)],
    );
    if (first.repositoryKind === null) {
      if (refs.length > 0) return yield* Effect.fail(new Error("checkpoint refs lack a workspace"));
      if (cwd.length > 0 && (yield* workspaceExists(cwd))) {
        return yield* Effect.fail(new Error("checkpoint workspace appeared after absent capture"));
      }
      yield* input.queries.markCheckpointRefsVerified(job.jobId);
      return;
    }
    if (first.repositoryKind === "non-git") {
      if (refs.length > 0) {
        return yield* Effect.fail(new Error("non-Git checkpoint set contains refs"));
      }
      yield* input.queries.markCheckpointRefsVerified(job.jobId);
      return;
    }
    if (first.repositoryKind !== "git") {
      return yield* Effect.fail(new Error("checkpoint set lacks repository kind"));
    }
    if (
      first.workspaceCanonicalPath === null ||
      first.workspaceDevice === null ||
      first.workspaceInode === null ||
      first.gitCommonDirCanonicalPath === null ||
      first.gitCommonDirDevice === null ||
      first.gitCommonDirInode === null
    ) {
      return yield* Effect.fail(new Error("checkpoint refs lack bound repository identity"));
    }
    const identity = {
      workspace: {
        canonicalPath: first.workspaceCanonicalPath,
        device: first.workspaceDevice,
        inode: first.workspaceInode,
      },
      gitCommonDir: {
        canonicalPath: first.gitCommonDirCanonicalPath,
        device: first.gitCommonDirDevice,
        inode: first.gitCommonDirInode,
      },
    };
    yield* input.checkpointStore.deleteCheckpointRefs({ cwd, checkpointRefs: refs, identity });
    yield* input.checkpointStore.verifyCheckpointRefsAbsent({
      cwd,
      checkpointRefs: refs,
      identity,
    });
    const remaining = yield* input.checkpointStore.listThreadCheckpointRefs({
      cwd,
      threadId: job.entityId,
      identity,
    });
    if (remaining.length > 0) {
      return yield* Effect.fail(new Error("thread checkpoint refs appeared after capture"));
    }
    yield* input.queries.markCheckpointRefsVerified(job.jobId);
  });

  return { captureCheckpointRefs, deleteCheckpointRefs };
}
