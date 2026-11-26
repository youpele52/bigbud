import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, ThreadId } from "../core/baseSchemas";
import {
  GitPullRequestReference,
  GitPreparePullRequestThreadMode,
  GitStackedAction,
} from "./git.domain";
import {
  ExecutionTargetInputShape,
  GIT_LIST_BRANCHES_MAX_LIMIT,
  GitMutationOperationInputShape,
  TrimmedNonEmptyStringSchema,
} from "./git.shared";

export const GitFetchInput = Schema.Struct({
  ...ExecutionTargetInputShape,
  ...GitMutationOperationInputShape,
  cwd: TrimmedNonEmptyStringSchema,
});
export type GitFetchInput = typeof GitFetchInput.Type;

/**
 * Limits a discard to files the user saw. `paths` must be listed in the current status; `all`
 * also requires the listed set to equal the current changed files exactly.
 */
export const GitDiscardSelection = Schema.Struct({
  scope: Schema.Literals(["paths", "all"]),
  paths: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(10_000),
  ),
});
export type GitDiscardSelection = typeof GitDiscardSelection.Type;

export const GitDiscardChangesInput = Schema.Struct({
  ...ExecutionTargetInputShape,
  ...GitMutationOperationInputShape,
  cwd: TrimmedNonEmptyStringSchema,
  /** Omitted: legacy whole-tree `git checkout -- .` (tracked files only). */
  selection: Schema.optional(GitDiscardSelection),
});
export type GitDiscardChangesInput = typeof GitDiscardChangesInput.Type;

const GIT_LIST_COMMITS_MAX_LIMIT = 100;

export const GitStatusInput = Schema.Struct({
  ...ExecutionTargetInputShape,
  cwd: TrimmedNonEmptyStringSchema,
});
export type GitStatusInput = typeof GitStatusInput.Type;

export const GitPullInput = Schema.Struct({
  ...ExecutionTargetInputShape,
  ...GitMutationOperationInputShape,
  cwd: TrimmedNonEmptyStringSchema,
});
export type GitPullInput = typeof GitPullInput.Type;

export const GitRunStackedActionInput = Schema.Struct({
  ...ExecutionTargetInputShape,
  threadId: Schema.optional(ThreadId),
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
  commitMessage: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(10_000))),
  featureBranch: Schema.optional(Schema.Boolean),
  filePaths: Schema.optional(
    Schema.Array(TrimmedNonEmptyStringSchema).check(Schema.isMinLength(1)),
  ),
});
export type GitRunStackedActionInput = typeof GitRunStackedActionInput.Type;

export const GitListBranchesInput = Schema.Struct({
  ...ExecutionTargetInputShape,
  cwd: TrimmedNonEmptyStringSchema,
  query: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(256))),
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(GIT_LIST_BRANCHES_MAX_LIMIT)),
  ),
});
export type GitListBranchesInput = typeof GitListBranchesInput.Type;

export const GitListCommitsInput = Schema.Struct({
  ...ExecutionTargetInputShape,
  cwd: TrimmedNonEmptyStringSchema,
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(GIT_LIST_COMMITS_MAX_LIMIT))),
});
export type GitListCommitsInput = typeof GitListCommitsInput.Type;

export const GitGetCommitDetailsInput = Schema.Struct({
  ...ExecutionTargetInputShape,
  cwd: TrimmedNonEmptyStringSchema,
  commit: TrimmedNonEmptyStringSchema,
});
export type GitGetCommitDetailsInput = typeof GitGetCommitDetailsInput.Type;
/** One file of one commit, loaded on demand (History panel). */
export const GitGetCommitFileDiffInput = Schema.Struct({
  ...ExecutionTargetInputShape,
  cwd: TrimmedNonEmptyStringSchema,
  commit: TrimmedNonEmptyStringSchema,
  path: TrimmedNonEmptyStringSchema,
  /** Rename/copy source, so the diff pairs both sides. */
  oldPath: Schema.optional(TrimmedNonEmptyStringSchema),
  /** "large" raises the per-file cap after the user asks to load a too-large diff. */
  limit: Schema.optional(Schema.Literals(["default", "large"])),
});
export type GitGetCommitFileDiffInput = typeof GitGetCommitFileDiffInput.Type;

export const GitReadWorkingTreeDiffInput = Schema.Struct({
  ...ExecutionTargetInputShape,
  cwd: TrimmedNonEmptyStringSchema,
  path: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type GitReadWorkingTreeDiffInput = typeof GitReadWorkingTreeDiffInput.Type;

export const GitCreateWorktreeInput = Schema.Struct({
  ...ExecutionTargetInputShape,
  ...GitMutationOperationInputShape,
  cwd: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema,
  newBranch: Schema.optional(TrimmedNonEmptyStringSchema),
  path: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type GitCreateWorktreeInput = typeof GitCreateWorktreeInput.Type;

export const GitPullRequestRefInput = Schema.Struct({
  ...ExecutionTargetInputShape,
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
});
export type GitPullRequestRefInput = typeof GitPullRequestRefInput.Type;

export const GitPreparePullRequestThreadInput = Schema.Struct({
  ...ExecutionTargetInputShape,
  ...GitMutationOperationInputShape,
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
  mode: GitPreparePullRequestThreadMode,
  threadId: Schema.optional(ThreadId),
});
export type GitPreparePullRequestThreadInput = typeof GitPreparePullRequestThreadInput.Type;

export const GitRemoveWorktreeInput = Schema.Struct({
  ...ExecutionTargetInputShape,
  ...GitMutationOperationInputShape,
  cwd: TrimmedNonEmptyStringSchema,
  path: TrimmedNonEmptyStringSchema,
  force: Schema.optional(Schema.Boolean),
});
export type GitRemoveWorktreeInput = typeof GitRemoveWorktreeInput.Type;

export const GitCreateBranchInput = Schema.Struct({
  ...ExecutionTargetInputShape,
  ...GitMutationOperationInputShape,
  cwd: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema,
  checkout: Schema.optional(Schema.Boolean),
});
export type GitCreateBranchInput = typeof GitCreateBranchInput.Type;

export const GitRenameBranchInput = Schema.Struct({
  ...ExecutionTargetInputShape,
  ...GitMutationOperationInputShape,
  cwd: TrimmedNonEmptyStringSchema,
  oldBranch: TrimmedNonEmptyStringSchema,
  newBranch: TrimmedNonEmptyStringSchema,
});
export type GitRenameBranchInput = typeof GitRenameBranchInput.Type;

export const GitDeleteBranchInput = Schema.Struct({
  ...ExecutionTargetInputShape,
  ...GitMutationOperationInputShape,
  cwd: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema,
});
export type GitDeleteBranchInput = typeof GitDeleteBranchInput.Type;

export const GitCheckoutInput = Schema.Struct({
  ...ExecutionTargetInputShape,
  ...GitMutationOperationInputShape,
  cwd: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema,
});
export type GitCheckoutInput = typeof GitCheckoutInput.Type;

export const GitInitInput = Schema.Struct({
  ...ExecutionTargetInputShape,
  ...GitMutationOperationInputShape,
  cwd: TrimmedNonEmptyStringSchema,
});
export type GitInitInput = typeof GitInitInput.Type;
