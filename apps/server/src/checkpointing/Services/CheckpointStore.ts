/**
 * CheckpointStore - Repository interface for filesystem-backed workspace checkpoints.
 *
 * Owns hidden Git-ref checkpoint capture/restore and diff computation for a
 * workspace thread timeline. It does not store user-facing checkpoint metadata
 * and does not coordinate provider conversation rollback.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and exposes typed
 * domain errors for checkpoint storage operations.
 *
 * @module CheckpointStore
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { CheckpointStoreError } from "../Errors.ts";
import { CheckpointRef } from "@bigbud/contracts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface PathCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly path: string;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
}

export interface ListThreadCheckpointRefsInput {
  readonly cwd: string;
  readonly threadId: string;
  readonly identity?: CheckpointRepositoryIdentity;
}

export interface CheckpointPathIdentity {
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
}

export interface CheckpointRepositoryIdentity {
  readonly workspace: CheckpointPathIdentity;
  readonly gitCommonDir: CheckpointPathIdentity;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
  readonly identity?: CheckpointRepositoryIdentity;
}

/**
 * CheckpointStoreShape - Service API for checkpoint capture/restore and diff access.
 */
export interface CheckpointStoreShape {
  /** Capture a stable, canonical identity for a workspace and its Git object store. */
  readonly captureRepositoryIdentity: (
    cwd: string,
  ) => Effect.Effect<CheckpointRepositoryIdentity, CheckpointStoreError>;

  /**
   * Check whether cwd is inside a Git worktree.
   */
  readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Capture a checkpoint commit and store it at the provided checkpoint ref.
   *
   * Uses an isolated temporary Git index and writes a hidden ref.
   */
  readonly captureCheckpoint: (
    input: CaptureCheckpointInput,
  ) => Effect.Effect<void, CheckpointStoreError>;

  /** Capture only one literal workspace-relative path. */
  readonly capturePathCheckpoint: (
    input: PathCheckpointInput,
  ) => Effect.Effect<void, CheckpointStoreError>;

  /**
   * Check whether a checkpoint ref exists.
   */
  readonly hasCheckpointRef: (
    input: Omit<RestoreCheckpointInput, "fallbackToHead">,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Restore workspace/staging state to a checkpoint.
   *
   * Optionally falls back to current `HEAD` when the checkpoint ref is missing.
   */
  readonly restoreCheckpoint: (
    input: RestoreCheckpointInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /** Restore only one literal workspace-relative path. */
  readonly restorePathCheckpoint: (
    input: PathCheckpointInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Compute patch diff between two checkpoint refs.
   *
   * Can optionally treat missing "from" ref as `HEAD`.
   */
  readonly diffCheckpoints: (
    input: DiffCheckpointsInput,
  ) => Effect.Effect<string, CheckpointStoreError>;

  /**
   * Delete the provided checkpoint refs.
   *
   * Best-effort delete: missing refs are tolerated.
   */
  readonly listThreadCheckpointRefs: (
    input: ListThreadCheckpointRefsInput,
  ) => Effect.Effect<ReadonlyArray<CheckpointRef>, CheckpointStoreError>;

  readonly deleteCheckpointRefs: (
    input: DeleteCheckpointRefsInput,
  ) => Effect.Effect<void, CheckpointStoreError>;

  readonly verifyCheckpointRefsAbsent: (
    input: DeleteCheckpointRefsInput,
  ) => Effect.Effect<void, CheckpointStoreError>;
}

/**
 * CheckpointStore - Service tag for checkpoint persistence and restore operations.
 */
export class CheckpointStore extends ServiceMap.Service<CheckpointStore, CheckpointStoreShape>()(
  "t3/checkpointing/Services/CheckpointStore",
) {}
