import { Schema } from "effect";
import { NonNegativeInt, PositiveInt } from "../core/baseSchemas";
import {
  GitBranch,
  GitBranchStepStatus,
  GitCommitStepStatus,
  GitHostingProvider,
  GitPrStepStatus,
  GitPushStepStatus,
  GitResolvedPullRequest,
  GitRunStackedActionToast,
  GitStackedAction,
  GitStatusPr,
  GitWorktree,
} from "./git.domain";
import { TrimmedNonEmptyStringSchema } from "./git.shared";

export const GitCreateBranchResult = Schema.Struct({
  branch: TrimmedNonEmptyStringSchema,
});
export type GitCreateBranchResult = typeof GitCreateBranchResult.Type;

const GitStatusLocalShape = {
  isRepo: Schema.Boolean,
  hostingProvider: Schema.optional(GitHostingProvider),
  hasOriginRemote: Schema.Boolean,
  isDefaultBranch: Schema.Boolean,
  branch: Schema.NullOr(TrimmedNonEmptyStringSchema),
  hasWorkingTreeChanges: Schema.Boolean,
  workingTree: Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        path: TrimmedNonEmptyStringSchema,
        insertions: NonNegativeInt,
        deletions: NonNegativeInt,
      }),
    ),
    insertions: NonNegativeInt,
    deletions: NonNegativeInt,
  }),
};

const GitStatusRemoteShape = {
  hasUpstream: Schema.Boolean,
  aheadCount: NonNegativeInt,
  behindCount: NonNegativeInt,
  pr: Schema.NullOr(GitStatusPr),
};

export const GitStatusLocalResult = Schema.Struct(GitStatusLocalShape);
export type GitStatusLocalResult = typeof GitStatusLocalResult.Type;

export const GitStatusRemoteResult = Schema.Struct(GitStatusRemoteShape);
export type GitStatusRemoteResult = typeof GitStatusRemoteResult.Type;

export const GitStatusResult = Schema.Struct({
  ...GitStatusLocalShape,
  ...GitStatusRemoteShape,
});
export type GitStatusResult = typeof GitStatusResult.Type;

export const GitStatusStreamEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    local: GitStatusLocalResult,
    remote: Schema.NullOr(GitStatusRemoteResult),
  }),
  Schema.TaggedStruct("localUpdated", {
    local: GitStatusLocalResult,
  }),
  Schema.TaggedStruct("remoteUpdated", {
    remote: Schema.NullOr(GitStatusRemoteResult),
  }),
]);
export type GitStatusStreamEvent = typeof GitStatusStreamEvent.Type;

export const GitListBranchesResult = Schema.Struct({
  branches: Schema.Array(GitBranch),
  isRepo: Schema.Boolean,
  hasOriginRemote: Schema.Boolean,
  nextCursor: NonNegativeInt.pipe(Schema.NullOr),
  totalCount: NonNegativeInt,
});
export type GitListBranchesResult = typeof GitListBranchesResult.Type;

export const GitCreateWorktreeResult = Schema.Struct({
  worktree: GitWorktree,
});
export type GitCreateWorktreeResult = typeof GitCreateWorktreeResult.Type;

export const GitResolvePullRequestResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
});
export type GitResolvePullRequestResult = typeof GitResolvePullRequestResult.Type;

export const GitPreparePullRequestThreadResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
  branch: TrimmedNonEmptyStringSchema,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type GitPreparePullRequestThreadResult = typeof GitPreparePullRequestThreadResult.Type;

export const GitCheckoutResult = Schema.Struct({
  branch: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type GitCheckoutResult = typeof GitCheckoutResult.Type;

export const GitRunStackedActionResult = Schema.Struct({
  action: GitStackedAction,
  branch: Schema.Struct({
    status: GitBranchStepStatus,
    name: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  commit: Schema.Struct({
    status: GitCommitStepStatus,
    commitSha: Schema.optional(TrimmedNonEmptyStringSchema),
    subject: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  push: Schema.Struct({
    status: GitPushStepStatus,
    branch: Schema.optional(TrimmedNonEmptyStringSchema),
    upstreamBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    setUpstream: Schema.optional(Schema.Boolean),
  }),
  pr: Schema.Struct({
    status: GitPrStepStatus,
    url: Schema.optional(Schema.String),
    number: Schema.optional(PositiveInt),
    baseBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    headBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    title: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  toast: GitRunStackedActionToast,
});
export type GitRunStackedActionResult = typeof GitRunStackedActionResult.Type;

export const GitPullResult = Schema.Struct({
  status: Schema.Literals(["pulled", "skipped_up_to_date"]),
  branch: TrimmedNonEmptyStringSchema,
  upstreamBranch: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type GitPullResult = typeof GitPullResult.Type;
