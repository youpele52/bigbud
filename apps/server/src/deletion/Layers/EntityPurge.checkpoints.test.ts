import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import type { CheckpointStoreShape } from "../../checkpointing/Services/CheckpointStore.ts";
import type { PurgeJob } from "../../persistence/Services/PurgeJobRepository.ts";
import { makeEntityPurgeCheckpointOps } from "./EntityPurge.checkpoints.ts";

const identity = {
  workspace: { canonicalPath: "/canonical/workspace", device: 11, inode: 12 },
  gitCommonDir: { canonicalPath: "/canonical/common.git", device: 21, inode: 22 },
};

const job = {
  jobId: "checkpoint-discovery-job",
  entityKind: "thread",
  entityId: ThreadId.makeUnsafe("checkpoint-discovery-thread"),
} as unknown as PurgeJob;

it.effect("records no refs only after proving the workspace is absent", () =>
  Effect.gen(function* () {
    let capturedCwd: string | undefined;
    const checkpointStore = {
      captureRepositoryIdentity: () => Effect.die("Git must not run for an absent workspace"),
    } as unknown as CheckpointStoreShape;
    const queries = {
      listCheckpointRefs: () => Effect.succeed([]),
      replaceCheckpointRefs: (input: { readonly workspaceCwd: string }) =>
        Effect.sync(() => {
          capturedCwd = input.workspaceCwd;
        }),
    } as never;
    const { captureCheckpointRefs } = makeEntityPurgeCheckpointOps({ checkpointStore, queries });
    yield* captureCheckpointRefs(job, [
      {
        activityKind: null,
        activityPayloadJson: null,
        attachmentsJson: null,
        worktreePath: null,
        workspaceRoot: `/tmp/bigbud-missing-checkpoint-${crypto.randomUUID()}`,
      },
    ]);
    assert.equal(capturedCwd, "");
  }),
);

it.effect("fails closed when repository identity capture fails", () =>
  Effect.gen(function* () {
    const workspace = process.cwd();
    const checkpointStore = {
      isGitRepository: () => Effect.succeed(true),
      captureRepositoryIdentity: () => Effect.fail(new Error("Git permission denied")),
    } as unknown as CheckpointStoreShape;
    const queries = {
      listCheckpointRefs: () => Effect.succeed([]),
      replaceCheckpointRefs: () => Effect.die("must not persist no refs"),
    } as never;
    const { captureCheckpointRefs } = makeEntityPurgeCheckpointOps({ checkpointStore, queries });
    assert.equal(
      (yield* Effect.exit(
        captureCheckpointRefs(job, [
          {
            activityKind: null,
            activityPayloadJson: null,
            attachmentsJson: null,
            worktreePath: null,
            workspaceRoot: workspace,
          },
        ]),
      ))._tag,
      "Failure",
    );
  }),
);

it.effect("persists an explicit empty set for an existing non-Git workspace", () =>
  Effect.gen(function* () {
    let persisted: Record<string, unknown> | undefined;
    const checkpointStore = {
      isGitRepository: () => Effect.succeed(false),
      captureRepositoryIdentity: () => Effect.die("must not capture non-Git identity"),
      listThreadCheckpointRefs: () => Effect.die("must not list refs outside a Git repository"),
    } as unknown as CheckpointStoreShape;
    const queries = {
      listCheckpointRefs: () => Effect.succeed([]),
      replaceCheckpointRefs: (input: Record<string, unknown>) =>
        Effect.sync(() => {
          persisted = input;
        }),
    } as never;
    const { captureCheckpointRefs } = makeEntityPurgeCheckpointOps({ checkpointStore, queries });

    yield* captureCheckpointRefs(job, [
      {
        activityKind: null,
        activityPayloadJson: null,
        attachmentsJson: null,
        worktreePath: process.cwd(),
        workspaceRoot: null,
      },
    ]);

    assert.deepEqual(persisted, {
      jobId: job.jobId,
      workspaceCwd: process.cwd(),
      repositoryKind: "non-git",
      workspaceCanonicalPath: null,
      workspaceDevice: null,
      workspaceInode: null,
      gitCommonDirCanonicalPath: null,
      gitCommonDirDevice: null,
      gitCommonDirInode: null,
      checkpointRefs: [],
    });
  }),
);

it.effect("does not rediscover or overwrite an existing checkpoint ref set", () =>
  Effect.gen(function* () {
    const checkpointStore = {
      captureRepositoryIdentity: () => Effect.die("must not recapture repository identity"),
    } as unknown as CheckpointStoreShape;
    const queries = {
      listCheckpointRefs: () => Effect.succeed([{ workspaceCwd: "/persisted" }]),
      replaceCheckpointRefs: () => Effect.die("must not overwrite checkpoint binding"),
    } as never;
    const { captureCheckpointRefs } = makeEntityPurgeCheckpointOps({ checkpointStore, queries });

    yield* captureCheckpointRefs(job, []);
  }),
);

it.effect("persists the bound workspace and Git common-directory identity", () =>
  Effect.gen(function* () {
    let persisted: Record<string, unknown> | undefined;
    let listedIdentity: unknown;
    const checkpointStore = {
      isGitRepository: () => Effect.succeed(true),
      captureRepositoryIdentity: () => Effect.succeed(identity),
      listThreadCheckpointRefs: (input: { readonly identity?: unknown }) =>
        Effect.sync(() => {
          listedIdentity = input.identity;
          return [];
        }),
    } as unknown as CheckpointStoreShape;
    const queries = {
      listCheckpointRefs: () => Effect.succeed([]),
      replaceCheckpointRefs: (input: Record<string, unknown>) =>
        Effect.sync(() => {
          persisted = input;
        }),
    } as never;
    const { captureCheckpointRefs } = makeEntityPurgeCheckpointOps({ checkpointStore, queries });

    yield* captureCheckpointRefs(job, [
      {
        activityKind: null,
        activityPayloadJson: null,
        attachmentsJson: null,
        worktreePath: null,
        workspaceRoot: process.cwd(),
      },
    ]);

    assert.deepEqual(listedIdentity, identity);
    assert.deepEqual(persisted, {
      jobId: job.jobId,
      workspaceCwd: process.cwd(),
      repositoryKind: "git",
      workspaceCanonicalPath: identity.workspace.canonicalPath,
      workspaceDevice: identity.workspace.device,
      workspaceInode: identity.workspace.inode,
      gitCommonDirCanonicalPath: identity.gitCommonDir.canonicalPath,
      gitCommonDirDevice: identity.gitCommonDir.device,
      gitCommonDirInode: identity.gitCommonDir.inode,
      checkpointRefs: [],
    });
  }),
);

it.effect("reuses the persisted identity for delete and verification", () =>
  Effect.gen(function* () {
    const calls: Array<{ readonly operation: string; readonly identity: unknown }> = [];
    const checkpointStore = {
      deleteCheckpointRefs: (input: { readonly identity?: unknown }) =>
        Effect.sync(() => calls.push({ operation: "delete", identity: input.identity })),
      verifyCheckpointRefsAbsent: (input: { readonly identity?: unknown }) =>
        Effect.sync(() => calls.push({ operation: "verify", identity: input.identity })),
      listThreadCheckpointRefs: () => Effect.succeed([]),
    } as unknown as CheckpointStoreShape;
    const queries = {
      listCheckpointRefs: () =>
        Effect.succeed([
          {
            workspaceCwd: "/declared/workspace",
            repositoryKind: "git",
            workspaceCanonicalPath: identity.workspace.canonicalPath,
            workspaceDevice: identity.workspace.device,
            workspaceInode: identity.workspace.inode,
            gitCommonDirCanonicalPath: identity.gitCommonDir.canonicalPath,
            gitCommonDirDevice: identity.gitCommonDir.device,
            gitCommonDirInode: identity.gitCommonDir.inode,
            checkpointRef: null,
            verifiedAt: null,
          },
        ]),
      markCheckpointRefsVerified: () => Effect.void,
    } as never;
    const { deleteCheckpointRefs } = makeEntityPurgeCheckpointOps({ checkpointStore, queries });

    yield* deleteCheckpointRefs(job);

    assert.deepEqual(calls, [
      { operation: "delete", identity },
      { operation: "verify", identity },
    ]);
  }),
);

it.effect("trusts a durable completed checkpoint verification after workspace removal", () =>
  Effect.gen(function* () {
    const checkpointStore = {
      captureRepositoryIdentity: () => Effect.die("must not inspect a removed workspace"),
    } as unknown as CheckpointStoreShape;
    const queries = {
      listCheckpointRefs: () =>
        Effect.succeed([{ workspaceCwd: "/removed", verifiedAt: "2026-08-04T00:00:00.000Z" }]),
    } as never;
    const { deleteCheckpointRefs } = makeEntityPurgeCheckpointOps({ checkpointStore, queries });
    yield* deleteCheckpointRefs(job);
  }),
);
