import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export function makeEntityPurgeCheckpointSql(sql: SqlClient.SqlClient) {
  const replaceCheckpointRefs = (input: {
    readonly jobId: string;
    readonly workspaceCwd: string;
    readonly repositoryKind: "git" | "non-git" | null;
    readonly workspaceCanonicalPath: string | null;
    readonly workspaceDevice: number | null;
    readonly workspaceInode: number | null;
    readonly gitCommonDirCanonicalPath: string | null;
    readonly gitCommonDirDevice: number | null;
    readonly gitCommonDirInode: number | null;
    readonly checkpointRefs: ReadonlyArray<string>;
  }) =>
    Effect.uninterruptible(
      sql.withTransaction(
        Effect.gen(function* () {
          const existingSets = yield* sql<{
            readonly workspaceCwd: string;
            readonly repositoryKind: "git" | "non-git" | null;
            readonly workspaceCanonicalPath: string | null;
            readonly workspaceDevice: number | null;
            readonly workspaceInode: number | null;
            readonly gitCommonDirCanonicalPath: string | null;
            readonly gitCommonDirDevice: number | null;
            readonly gitCommonDirInode: number | null;
          }>`
          SELECT workspace_cwd AS "workspaceCwd",
            repository_kind AS "repositoryKind",
            workspace_canonical_path AS "workspaceCanonicalPath",
            workspace_device AS "workspaceDevice", workspace_inode AS "workspaceInode",
            git_common_dir_canonical_path AS "gitCommonDirCanonicalPath",
            git_common_dir_device AS "gitCommonDirDevice",
            git_common_dir_inode AS "gitCommonDirInode"
          FROM purge_checkpoint_ref_sets WHERE job_id = ${input.jobId}
        `;
          if (existingSets.length > 0) {
            const existing = existingSets[0]!;
            const existingRefs = (yield* sql<{ readonly checkpointRef: string }>`
              SELECT checkpoint_ref AS "checkpointRef" FROM purge_checkpoint_refs
              WHERE job_id = ${input.jobId} ORDER BY checkpoint_ref
            `).map((row) => row.checkpointRef);
            const sameBinding =
              existing.workspaceCwd === input.workspaceCwd &&
              existing.repositoryKind === input.repositoryKind &&
              existing.workspaceCanonicalPath === input.workspaceCanonicalPath &&
              existing.workspaceDevice === input.workspaceDevice &&
              existing.workspaceInode === input.workspaceInode &&
              existing.gitCommonDirCanonicalPath === input.gitCommonDirCanonicalPath &&
              existing.gitCommonDirDevice === input.gitCommonDirDevice &&
              existing.gitCommonDirInode === input.gitCommonDirInode &&
              JSON.stringify(existingRefs) === JSON.stringify(input.checkpointRefs.toSorted());
            if (!sameBinding) {
              return yield* Effect.fail(
                new Error("purge checkpoint repository binding changed after capture"),
              );
            }
            return;
          }
          yield* sql`
          INSERT INTO purge_checkpoint_ref_sets (
            job_id, workspace_cwd, repository_kind,
            workspace_canonical_path, workspace_device, workspace_inode,
            git_common_dir_canonical_path, git_common_dir_device, git_common_dir_inode, captured_at
          ) VALUES (
            ${input.jobId}, ${input.workspaceCwd}, ${input.repositoryKind},
            ${input.workspaceCanonicalPath},
            ${input.workspaceDevice}, ${input.workspaceInode}, ${input.gitCommonDirCanonicalPath},
            ${input.gitCommonDirDevice}, ${input.gitCommonDirInode}, ${new Date().toISOString()}
          )
        `;
          yield* Effect.forEach(
            input.checkpointRefs,
            (checkpointRef) => sql`
            INSERT INTO purge_checkpoint_refs (job_id, workspace_cwd, checkpoint_ref)
            VALUES (${input.jobId}, ${input.workspaceCwd}, ${checkpointRef})
          `,
            { concurrency: 1, discard: true },
          );
        }),
      ),
    );

  const listCheckpointRefs = (jobId: string) => sql<{
    readonly workspaceCwd: string;
    readonly repositoryKind: "git" | "non-git" | null;
    readonly workspaceCanonicalPath: string | null;
    readonly workspaceDevice: number | null;
    readonly workspaceInode: number | null;
    readonly gitCommonDirCanonicalPath: string | null;
    readonly gitCommonDirDevice: number | null;
    readonly gitCommonDirInode: number | null;
    readonly checkpointRef: string | null;
    readonly verifiedAt: string | null;
  }>`
    SELECT ref_set.workspace_cwd AS "workspaceCwd",
      ref_set.repository_kind AS "repositoryKind",
      ref_set.workspace_canonical_path AS "workspaceCanonicalPath",
      ref_set.workspace_device AS "workspaceDevice",
      ref_set.workspace_inode AS "workspaceInode",
      ref_set.git_common_dir_canonical_path AS "gitCommonDirCanonicalPath",
      ref_set.git_common_dir_device AS "gitCommonDirDevice",
      ref_set.git_common_dir_inode AS "gitCommonDirInode",
      ref.checkpoint_ref AS "checkpointRef", ref_set.verified_at AS "verifiedAt"
    FROM purge_checkpoint_ref_sets AS ref_set
    LEFT JOIN purge_checkpoint_refs AS ref ON ref.job_id = ref_set.job_id
    WHERE ref_set.job_id = ${jobId} ORDER BY ref.checkpoint_ref
  `;

  const markCheckpointRefsVerified = (jobId: string) =>
    sql`UPDATE purge_checkpoint_ref_sets SET verified_at = ${new Date().toISOString()}
      WHERE job_id = ${jobId} AND verified_at IS NULL`.pipe(Effect.asVoid);

  return { replaceCheckpointRefs, listCheckpointRefs, markCheckpointRefsVerified };
}
