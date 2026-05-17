import { Schema } from "effect";
import { PositiveInt } from "../core/baseSchemas";
import {
  GIT_ACTION_PROGRESS_KINDS,
  GIT_ACTION_PROGRESS_PHASES,
  GIT_ACTION_PROGRESS_STREAMS,
  GIT_PR_STATES,
  GIT_PREPARE_PR_THREAD_MODES,
  GIT_STACKED_ACTIONS,
} from "../constants/git.constant";
import { TrimmedNonEmptyStringSchema } from "./git.shared";

export const GitStackedAction = Schema.Literals(GIT_STACKED_ACTIONS);
export type GitStackedAction = typeof GitStackedAction.Type;
export const GitActionProgressPhase = Schema.Literals(GIT_ACTION_PROGRESS_PHASES);
export type GitActionProgressPhase = typeof GitActionProgressPhase.Type;
export const GitActionProgressKind = Schema.Literals(GIT_ACTION_PROGRESS_KINDS);
export type GitActionProgressKind = typeof GitActionProgressKind.Type;
export const GitActionProgressStream = Schema.Literals(GIT_ACTION_PROGRESS_STREAMS);
export type GitActionProgressStream = typeof GitActionProgressStream.Type;
export const GitCommitStepStatus = Schema.Literals([
  "created",
  "skipped_no_changes",
  "skipped_not_requested",
]);
export const GitPushStepStatus = Schema.Literals([
  "pushed",
  "skipped_not_requested",
  "skipped_up_to_date",
]);
export const GitBranchStepStatus = Schema.Literals(["created", "skipped_not_requested"]);
export const GitPrStepStatus = Schema.Literals([
  "created",
  "opened_existing",
  "skipped_not_requested",
]);
export const GitStatusPrState = Schema.Literals(GIT_PR_STATES);
export const GitPullRequestReference = TrimmedNonEmptyStringSchema;
export const GitPullRequestState = Schema.Literals(GIT_PR_STATES);
export const GitPreparePullRequestThreadMode = Schema.Literals(GIT_PREPARE_PR_THREAD_MODES);
export const GitHostingProviderKind = Schema.Literals(["github", "gitlab", "unknown"]);
export type GitHostingProviderKind = typeof GitHostingProviderKind.Type;
export const GitHostingProvider = Schema.Struct({
  kind: GitHostingProviderKind,
  name: TrimmedNonEmptyStringSchema,
  baseUrl: Schema.String,
});
export type GitHostingProvider = typeof GitHostingProvider.Type;
export const GitRunStackedActionToastRunAction = Schema.Struct({
  kind: GitStackedAction,
});
export type GitRunStackedActionToastRunAction = typeof GitRunStackedActionToastRunAction.Type;
export const GitRunStackedActionToastCta = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("open_pr"),
    label: TrimmedNonEmptyStringSchema,
    url: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("run_action"),
    label: TrimmedNonEmptyStringSchema,
    action: GitRunStackedActionToastRunAction,
  }),
]);
export type GitRunStackedActionToastCta = typeof GitRunStackedActionToastCta.Type;
export const GitRunStackedActionToast = Schema.Struct({
  title: TrimmedNonEmptyStringSchema,
  description: Schema.optional(TrimmedNonEmptyStringSchema),
  cta: GitRunStackedActionToastCta,
});
export type GitRunStackedActionToast = typeof GitRunStackedActionToast.Type;

export const GitBranch = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  isRemote: Schema.optional(Schema.Boolean),
  remoteName: Schema.optional(TrimmedNonEmptyStringSchema),
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type GitBranch = typeof GitBranch.Type;

export const GitWorktree = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  branch: TrimmedNonEmptyStringSchema,
});
export const GitResolvedPullRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyStringSchema,
  headBranch: TrimmedNonEmptyStringSchema,
  state: GitPullRequestState,
});
export type GitResolvedPullRequest = typeof GitResolvedPullRequest.Type;

export const GitStatusPr = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyStringSchema,
  headBranch: TrimmedNonEmptyStringSchema,
  state: GitStatusPrState,
});
