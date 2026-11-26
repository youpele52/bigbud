import type { ExecuteGitInput, ExecuteGitResult } from "../Services/GitCore.ts";

/**
 * Branch, checkout, commit, worktree and range Git on a direct SSH target (B). Each entry is the
 * exact argv the product issues, as literal words and typed slots, mirrored one-to-one by the
 * owner's templates (`transport/workspace/git.templates.rs`, actions 26-74). Only slot values
 * travel; the owner validates each by type and compiles its own argv. Commits run the
 * repository's hooks on the target, as any commit there would.
 *
 * @module GitCore.ssh.owner.templates
 */
type Slot =
  | "ref"
  | "refsHeads"
  | "refsRemotes"
  | "rangeToHead"
  | "message"
  | "paths"
  | "worktree"
  | "commit"
  | "refOrCommit"
  | "stashRef"
  | "remoteName"
  | "remoteUrl";
type Word = string | { readonly slot: Slot };

const ref = { slot: "ref" } as const;
const range = { slot: "rangeToHead" } as const;
const message = { slot: "message" } as const;
const worktree = { slot: "worktree" } as const;

interface Template {
  readonly action: DirectWorkspaceGitTemplateAction;
  readonly words: ReadonlyArray<Word>;
  /** Output cap the product reads with a flagged cut. */
  readonly cap?: number;
}

const TEMPLATES = [
  { action: "showRefHead", words: ["show-ref", "--verify", "--quiet", { slot: "refsHeads" }] },
  { action: "showRefRemote", words: ["show-ref", "--verify", "--quiet", { slot: "refsRemotes" }] },
  {
    action: "trackingRefs",
    words: ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"],
  },
  { action: "currentBranch", words: ["branch", "--show-current"] },
  {
    action: "originHeadShort",
    words: ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
  },
  { action: "worktreeList", words: ["worktree", "list", "--porcelain"] },
  { action: "localBranchList", words: ["branch", "--no-color", "--no-column"] },
  { action: "remoteBranchList", words: ["branch", "--no-color", "--no-column", "--remotes"] },
  { action: "remoteNames", words: ["remote"] },
  { action: "remoteUrls", words: ["remote", "-v"] },
  {
    action: "branchMetadata",
    words: [
      "for-each-ref",
      "--format=%(refname:short)%09%(committerdate:unix)%09%(upstream:short)",
      "refs/heads",
      "refs/remotes",
    ],
  },
  { action: "rangeLog", words: ["log", "--oneline", range], cap: 19_000 },
  { action: "rangeDiffStat", words: ["diff", "--stat", range], cap: 19_000 },
  { action: "rangeDiffPatch", words: ["diff", "--patch", "--minimal", range], cap: 59_000 },
  { action: "stagedSummary", words: ["diff", "--cached", "--name-status"] },
  { action: "stagedPatch", words: ["diff", "--cached", "--patch", "--minimal"], cap: 49_000 },
  { action: "revParseHead", words: ["rev-parse", "HEAD"] },
  { action: "resetIndex", words: ["reset"] },
  { action: "addAll", words: ["add", "-A"] },
  { action: "addSelected", words: ["add", "-A", "--", { slot: "paths" }] },
  { action: "commit", words: ["commit", "-m", message] },
  { action: "commitWithBody", words: ["commit", "-m", message, "-m", message] },
  { action: "checkout", words: ["checkout", ref] },
  { action: "checkoutTrack", words: ["checkout", "--track", ref] },
  { action: "branchCreate", words: ["branch", ref] },
  { action: "branchRenameCurrent", words: ["branch", "-m", "--", ref] },
  { action: "branchRename", words: ["branch", "-m", "--", ref, ref] },
  { action: "branchDelete", words: ["branch", "-d", "--", ref] },
  { action: "setUpstream", words: ["branch", "--set-upstream-to", ref, ref] },
  { action: "worktreeAdd", words: ["worktree", "add", worktree, ref] },
  { action: "worktreeAddNewBranch", words: ["worktree", "add", "-b", ref, worktree, ref] },
  { action: "worktreeRemove", words: ["worktree", "remove", worktree] },
  { action: "worktreeRemoveForce", words: ["worktree", "remove", "--force", worktree] },
  // 59 (read): the branch list's default-branch probe.
  { action: "originHeadRef", words: ["symbolic-ref", "refs/remotes/origin/HEAD"] },
  // 60-74: force delete of the named branch, new branches, stash, init, remote add and the
  // worktree-creation recipe at a fixed commit.
  { action: "branchForceDelete", words: ["branch", "-D", "--", ref] },
  { action: "checkoutNewBranch", words: ["checkout", "-b", ref] },
  { action: "checkoutNewBranchFrom", words: ["checkout", "-b", ref, { slot: "refOrCommit" }] },
  { action: "stashPush", words: ["stash", "push"] },
  { action: "stashPushMessage", words: ["stash", "push", "-m", message] },
  { action: "stashPop", words: ["stash", "pop"] },
  { action: "stashPopRef", words: ["stash", "pop", { slot: "stashRef" }] },
  { action: "stashApply", words: ["stash", "apply"] },
  { action: "stashApplyRef", words: ["stash", "apply", { slot: "stashRef" }] },
  { action: "stashList", words: ["stash", "list"] },
  { action: "stashDrop", words: ["stash", "drop"] },
  { action: "stashDropRef", words: ["stash", "drop", { slot: "stashRef" }] },
  { action: "init", words: ["init"] },
  { action: "remoteAdd", words: ["remote", "add", { slot: "remoteName" }, { slot: "remoteUrl" }] },
  {
    action: "worktreeAddNewBranchAt",
    words: ["worktree", "add", "-b", ref, "--", worktree, { slot: "commit" }],
  },
] as const satisfies ReadonlyArray<{
  readonly action: string;
  readonly words: ReadonlyArray<Word>;
  readonly cap?: number;
}>;

export type DirectWorkspaceGitTemplateAction = (typeof TEMPLATES)[number]["action"];

export interface DirectWorkspaceGitTemplateRequest {
  readonly action: DirectWorkspaceGitTemplateAction;
  readonly executionTargetId: string;
  readonly cwd: string;
  readonly operands: ReadonlyArray<string>;
}

export interface DirectWorkspaceGitTemplateOwner {
  /** Mutations may report `DirectWorkspaceGitOutcomeUnknown`; capped reads `stdoutTruncated`. */
  readonly execute: (
    request: DirectWorkspaceGitTemplateRequest,
    signal: AbortSignal,
  ) => Promise<ExecuteGitResult>;
}

function slotValue(slot: Slot, arg: string): string | undefined {
  if (arg.length === 0 || arg.includes("\0")) return undefined;
  switch (slot) {
    case "message":
      return arg;
    case "refsHeads":
      return arg.startsWith("refs/heads/") ? arg : undefined;
    case "refsRemotes":
      return arg.startsWith("refs/remotes/") ? arg : undefined;
    case "rangeToHead":
      return arg.endsWith("..HEAD") ? arg : undefined;
    case "worktree":
      return arg.startsWith("/") ? arg : undefined;
    case "commit":
      return /^[0-9a-f]{4,64}$/u.test(arg) ? arg : undefined;
    case "stashRef":
      return /^stash@\{\d{1,4}\}$/u.test(arg) ? arg : undefined;
    case "remoteUrl":
      return arg.startsWith("-") || arg.includes("::") ? undefined : arg;
    default:
      return arg.startsWith("-") ? undefined : arg;
  }
}

function match(template: Template, args: ReadonlyArray<string>): string[] | undefined {
  const operands: string[] = [];
  let index = 0;
  for (const word of template.words) {
    if (typeof word === "string") {
      if (args[index++] !== word) return undefined;
      continue;
    }
    if (word.slot === "paths") {
      const rest = args.slice(index);
      if (rest.length === 0 || rest.some((path) => path.length === 0)) return undefined;
      operands.push(...rest);
      index = args.length;
      continue;
    }
    const value = slotValue(word.slot, args[index++] ?? "");
    if (value === undefined) return undefined;
    operands.push(value);
  }
  return index === args.length ? operands : undefined;
}

/** Match one exact template argv; anything else is not owner-supported. */
export function selectTemplate(input: ExecuteGitInput):
  | {
      readonly action: DirectWorkspaceGitTemplateAction;
      readonly operands: string[];
      readonly capped: boolean;
    }
  | undefined {
  if (input.env !== undefined || input.stdin !== undefined) return undefined;
  for (const template of TEMPLATES as ReadonlyArray<Template>) {
    const operands = match(template, input.args);
    if (!operands) continue;
    const capped = template.cap !== undefined;
    if (capped) {
      if (input.maxOutputBytes !== template.cap || input.truncateOutputAtMaxBytes !== true) {
        return undefined;
      }
    } else if (input.maxOutputBytes !== undefined || input.truncateOutputAtMaxBytes !== undefined) {
      return undefined;
    }
    return { action: template.action, operands, capped };
  }
  return undefined;
}

/** Owner action tags 26-74, in template order. */
export const TEMPLATE_ACTION_TAGS = Object.fromEntries(
  TEMPLATES.map((template, index) => [template.action, 26 + index]),
) as Record<DirectWorkspaceGitTemplateAction, number>;

/** Read-only templates; every other template mutates (owner deadline 120 s). */
const TEMPLATE_READS = new Set<string>([
  ...TEMPLATES.slice(0, 17).map((template) => template.action),
  "originHeadRef",
  "stashList",
]);

/** Template mutations: the owner allows them up to 120 s (hooks, checkouts). */
export function isTemplateMutation(action: string): boolean {
  return action in TEMPLATE_ACTION_TAGS && !TEMPLATE_READS.has(action);
}
