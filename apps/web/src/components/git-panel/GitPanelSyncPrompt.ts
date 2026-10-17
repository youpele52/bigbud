import type { GitStatusResult } from "@bigbud/contracts";

export type GitSyncAction = "pull" | "push" | "fetch";
export type GitSyncIssue =
  | "dirty_pull"
  | "dirty_push"
  | "diverged"
  | "detached"
  | "missing_upstream"
  | "missing_remote"
  | "status_unavailable"
  | "operation_failed";

export type GitSyncPromptPreference =
  | "investigate"
  | "stash_pull_restore"
  | "commit_before_pull"
  | "safeguard_before_push"
  | "rebase"
  | "merge"
  | "retry_fetch"
  | "inspect_remote"
  | "preserve_branch"
  | "configure_upstream";

export interface GitSyncPromptOption {
  value: GitSyncPromptPreference;
  label: string;
  description: string;
  ctaLabel: string;
}

export interface GitSyncPromptInput {
  cwd: string;
  executionTargetId?: string | undefined;
  status: GitStatusResult | null;
  action: GitSyncAction;
  issue: GitSyncIssue;
  preference: GitSyncPromptPreference;
  error?: string | null;
}

export function formatGitSyncSummary(status: GitStatusResult | null): string {
  if (!status) return "Remote status unavailable";
  if (status.aheadCount === 0 && status.behindCount === 0) return "Up to date";
  if (status.aheadCount > 0 && status.behindCount > 0) {
    return `${status.aheadCount} ahead, ${status.behindCount} behind`;
  }
  if (status.aheadCount > 0) {
    return status.aheadCount === 1 ? "1 ahead" : `${status.aheadCount} ahead`;
  }
  return status.behindCount === 1 ? "1 behind" : `${status.behindCount} behind`;
}

export function gitSyncActionLabel(action: GitSyncAction, count: number): string {
  if (action === "fetch") return "Fetch";
  const noun = count === 1 ? "commit" : "commits";
  return `${action === "pull" ? "Pull" : "Push"} ${count} ${noun}`;
}

export function getGitSyncIssueOptions(issue: GitSyncIssue): GitSyncPromptOption[] {
  const investigate: GitSyncPromptOption = {
    value: "investigate",
    label: "Investigate thoroughly and recommend the safest option",
    description:
      "Inspect the repository and explain the safest next step before changing anything.",
    ctaLabel: "Prepare investigation prompt",
  };
  if (issue === "dirty_pull") {
    return [
      investigate,
      {
        value: "stash_pull_restore",
        label: "Stash, pull, then restore my changes",
        description:
          "Preserve local changes while applying incoming commits, then restore the stash.",
        ctaLabel: "Prepare stash-and-pull prompt",
      },
      {
        value: "commit_before_pull",
        label: "Help me commit my changes before pulling",
        description: "Review the changes and propose a safe commit before Pull.",
        ctaLabel: "Prepare commit-before-pull prompt",
      },
    ];
  }
  if (issue === "dirty_push") {
    return [
      investigate,
      {
        value: "safeguard_before_push",
        label: "Help me safeguard local changes before pushing",
        description: "Verify that uncommitted work is protected before Push.",
        ctaLabel: "Prepare safeguard-before-push prompt",
      },
    ];
  }
  if (issue === "diverged") {
    return [
      investigate,
      {
        value: "rebase",
        label: "Help me evaluate a rebase resolution",
        description: "Inspect the history and explain rebase risks before asking for approval.",
        ctaLabel: "Prepare rebase-resolution prompt",
      },
      {
        value: "merge",
        label: "Help me evaluate a merge resolution",
        description: "Inspect the history and explain merge risks before asking for approval.",
        ctaLabel: "Prepare merge-resolution prompt",
      },
    ];
  }
  if (issue === "missing_upstream") {
    return [
      investigate,
      {
        value: "configure_upstream",
        label: "Help me configure the correct upstream",
        description: "Inspect available remotes and recommend the correct tracking branch.",
        ctaLabel: "Prepare upstream-configuration prompt",
      },
    ];
  }
  if (issue === "missing_remote") {
    return [
      investigate,
      {
        value: "inspect_remote",
        label: "Help me inspect the remote configuration",
        description: "Check the remote URL and explain how to repair it safely.",
        ctaLabel: "Prepare remote-diagnosis prompt",
      },
    ];
  }
  if (issue === "detached") {
    return [
      investigate,
      {
        value: "preserve_branch",
        label: "Help me preserve this work on a branch",
        description: "Identify the safest branch action without losing the detached commit.",
        ctaLabel: "Prepare branch-preservation prompt",
      },
    ];
  }
  if (issue === "status_unavailable" || issue === "operation_failed") {
    return [
      investigate,
      {
        value: "retry_fetch",
        label: "Help me diagnose and safely retry the remote operation",
        description: "Check authentication, connectivity, and remote configuration first.",
        ctaLabel: "Prepare remote-retry prompt",
      },
    ];
  }
  return [investigate];
}

function statusFacts(status: GitStatusResult | null): string[] {
  if (!status) return ["- Git status: unavailable or could not be confirmed"];
  return [
    `- Branch: ${status.branch ?? "detached HEAD"}`,
    `- Upstream: ${status.hasUpstream ? "configured (exact ref unavailable)" : "not configured"}`,
    `- Remote status: ${formatGitSyncSummary(status)}`,
    `- Working tree: ${status.hasWorkingTreeChanges ? `contains changes (${status.workingTree.files.length} changed files)` : "clean"}`,
    `- Origin remote: ${status.hasOriginRemote ? "available" : "not available"}`,
  ];
}

function preferenceInstruction(preference: GitSyncPromptPreference): string {
  switch (preference) {
    case "stash_pull_restore":
      return "My preferred approach is to preserve uncommitted work with a stash, use fast-forward-only Pull, and restore the stash. Never drop the stash automatically; stop on conflicts.";
    case "commit_before_pull":
      return "My preferred approach is to review the changes and propose a commit before Pull. Do not commit until I explicitly approve the commit boundary and message.";
    case "safeguard_before_push":
      return "My preferred approach is to verify that uncommitted work is protected before Push. Do not alter or commit that work without approval.";
    case "rebase":
      return "Please evaluate rebase as a possible resolution, explain the risks, and wait for explicit approval before any history-changing command.";
    case "merge":
      return "Please evaluate merge as a possible resolution, explain the risks, and wait for explicit approval before any history-changing command.";
    case "retry_fetch":
      return "Focus on diagnosing authentication, connectivity, and remote configuration before proposing a safe retry.";
    case "inspect_remote":
      return "Focus on inspecting and explaining the remote configuration before changing it.";
    case "preserve_branch":
      return "Focus on preserving the detached work on a branch without losing commits.";
    case "configure_upstream":
      return "Inspect available remotes and recommend the correct upstream before changing tracking configuration.";
    default:
      return "Investigate thoroughly and recommend the safest option. Do not mutate Git while investigating.";
  }
}

export function buildGitSyncPrompt(input: GitSyncPromptInput): string {
  const actionLabel = input.action.charAt(0).toUpperCase() + input.action.slice(1);
  return [
    `I’m having a Git synchronization issue while trying to ${actionLabel}. Investigate it thoroughly and recommend the safest way to resolve it.`,
    "",
    "Repository context:",
    `- Workspace: ${input.cwd}`,
    `- Execution target: ${input.executionTargetId ?? "local"}`,
    ...statusFacts(input.status),
    `- Requested operation: ${actionLabel}`,
    `- Detected issue: ${input.issue}`,
    ...(input.error ? [`- Error: ${input.error}`] : []),
    "",
    "Preferred approach:",
    preferenceInstruction(input.preference),
    "",
    "Safety requirements:",
    "1. Verify the repository root, branch/HEAD, upstream/remotes, ahead/behind counts, and working tree before acting.",
    "2. Protect tracked, staged, unstaged, and untracked local work; stop if the observed state differs from these facts.",
    "3. Never discard, reset, clean, overwrite, or force-push local work.",
    "4. Do not commit or push without my explicit approval in this chat.",
    "5. Do not silently merge or rebase. Preserve fast-forward-only Pull unless I explicitly approve another strategy.",
    "6. Explain risks and ask for approval before any mutating or history-changing command.",
  ].join("\n");
}
