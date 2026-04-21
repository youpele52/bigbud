import type {
  GitBranch,
  GitHostingProvider,
  GitStatusLocalResult,
  GitStatusRemoteResult,
  GitStatusResult,
  GitStatusStreamEvent,
} from "@bigbud/contracts";

/**
 * Sanitize an arbitrary string into a valid, lowercase git branch fragment.
 * Strips quotes, collapses separators, limits to 64 chars.
 */
export function sanitizeBranchFragment(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/^[./\s_-]+|[./\s_-]+$/g, "");

  const branchFragment = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  return branchFragment.length > 0 ? branchFragment : "update";
}

/**
 * Sanitize a string into a `feature/…` branch name.
 * Preserves an existing `feature/` prefix or slash-separated namespace.
 */
export function sanitizeFeatureBranchName(raw: string): string {
  const sanitized = sanitizeBranchFragment(raw);
  if (sanitized.includes("/")) {
    return sanitized.startsWith("feature/") ? sanitized : `feature/${sanitized}`;
  }
  return `feature/${sanitized}`;
}

const AUTO_FEATURE_BRANCH_FALLBACK = "feature/update";

/**
 * Resolve a unique `feature/…` branch name that doesn't collide with
 * any existing branch. Appends a numeric suffix when needed.
 */
export function resolveAutoFeatureBranchName(
  existingBranchNames: readonly string[],
  preferredBranch?: string,
): string {
  const preferred = preferredBranch?.trim();
  const resolvedBase = sanitizeFeatureBranchName(
    preferred && preferred.length > 0 ? preferred : AUTO_FEATURE_BRANCH_FALLBACK,
  );
  const existingNames = new Set(existingBranchNames.map((branch) => branch.toLowerCase()));

  if (!existingNames.has(resolvedBase)) {
    return resolvedBase;
  }

  let suffix = 2;
  while (existingNames.has(`${resolvedBase}-${suffix}`)) {
    suffix += 1;
  }

  return `${resolvedBase}-${suffix}`;
}

/**
 * Strip the remote prefix from a remote ref such as `origin/feature/demo`.
 */
export function deriveLocalBranchNameFromRemoteRef(branchName: string): string {
  const firstSeparatorIndex = branchName.indexOf("/");
  if (firstSeparatorIndex <= 0 || firstSeparatorIndex === branchName.length - 1) {
    return branchName;
  }
  return branchName.slice(firstSeparatorIndex + 1);
}

function deriveLocalBranchNameCandidatesFromRemoteRef(
  branchName: string,
  remoteName?: string,
): ReadonlyArray<string> {
  const candidates = new Set<string>();
  const firstSlashCandidate = deriveLocalBranchNameFromRemoteRef(branchName);
  if (firstSlashCandidate.length > 0) {
    candidates.add(firstSlashCandidate);
  }

  if (remoteName) {
    const remotePrefix = `${remoteName}/`;
    if (branchName.startsWith(remotePrefix) && branchName.length > remotePrefix.length) {
      candidates.add(branchName.slice(remotePrefix.length));
    }
  }

  return [...candidates];
}

/**
 * Hide `origin/*` remote refs when a matching local branch already exists.
 */
export function dedupeRemoteBranchesWithLocalMatches(
  branches: ReadonlyArray<GitBranch>,
): ReadonlyArray<GitBranch> {
  const localBranchNames = new Set(
    branches.filter((branch) => !branch.isRemote).map((branch) => branch.name),
  );

  return branches.filter((branch) => {
    if (!branch.isRemote) {
      return true;
    }

    if (branch.remoteName !== "origin") {
      return true;
    }

    const localBranchCandidates = deriveLocalBranchNameCandidatesFromRemoteRef(
      branch.name,
      branch.remoteName,
    );
    return !localBranchCandidates.some((candidate) => localBranchNames.has(candidate));
  });
}

// ── Git hosting provider detection ───────────────────────────────────────────

const GITHUB_HOSTS = ["github.com", "github."];
const GITLAB_HOSTS = ["gitlab.com", "gitlab."];

/**
 * Detect the Git hosting provider from a remote URL.
 * Supports both HTTPS and SSH remote URL formats.
 */
export function detectGitHostingProviderFromRemoteUrl(
  remoteUrl: string,
): GitHostingProvider | null {
  if (!remoteUrl || remoteUrl.trim().length === 0) {
    return null;
  }

  const normalized = remoteUrl.trim().toLowerCase();

  for (const host of GITHUB_HOSTS) {
    if (normalized.includes(host)) {
      return { kind: "github", name: "GitHub", baseUrl: "https://github.com" };
    }
  }

  for (const host of GITLAB_HOSTS) {
    if (normalized.includes(host)) {
      return { kind: "gitlab", name: "GitLab", baseUrl: "https://gitlab.com" };
    }
  }

  return null;
}

// ── Git status stream helpers ─────────────────────────────────────────────────

/**
 * Extract local-only fields from a full GitStatusResult.
 */
function toLocalStatusPart(full: GitStatusResult): GitStatusLocalResult {
  return {
    isRepo: full.isRepo,
    ...(full.hostingProvider !== undefined ? { hostingProvider: full.hostingProvider } : {}),
    hasOriginRemote: full.hasOriginRemote,
    isDefaultBranch: full.isDefaultBranch,
    branch: full.branch,
    hasWorkingTreeChanges: full.hasWorkingTreeChanges,
    workingTree: full.workingTree,
  };
}

/**
 * Extract remote-only fields from a full GitStatusResult.
 */
function toRemoteStatusPart(full: GitStatusResult): GitStatusRemoteResult {
  return {
    hasUpstream: full.hasUpstream,
    aheadCount: full.aheadCount,
    behindCount: full.behindCount,
    pr: full.pr,
  };
}

/**
 * Merge local and remote status parts into a full GitStatusResult.
 */
export function mergeGitStatusParts(
  local: GitStatusLocalResult,
  remote: GitStatusRemoteResult | null,
): GitStatusResult {
  return {
    ...local,
    hasUpstream: remote?.hasUpstream ?? false,
    aheadCount: remote?.aheadCount ?? 0,
    behindCount: remote?.behindCount ?? 0,
    pr: remote?.pr ?? null,
  };
}

/**
 * Apply a GitStatusStreamEvent to an existing (or null) GitStatusResult,
 * returning the updated full status.
 */
export function applyGitStatusStreamEvent(
  current: GitStatusResult | null,
  event: GitStatusStreamEvent,
): GitStatusResult {
  if (event._tag === "snapshot") {
    return mergeGitStatusParts(event.local, event.remote);
  }

  if (event._tag === "localUpdated") {
    if (current === null) {
      return mergeGitStatusParts(event.local, null);
    }
    return mergeGitStatusParts(event.local, toRemoteStatusPart(current));
  }

  // remoteUpdated
  if (current === null) {
    return mergeGitStatusParts(
      {
        isRepo: false,
        hasOriginRemote: false,
        isDefaultBranch: false,
        branch: null,
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
      },
      event.remote,
    );
  }
  return mergeGitStatusParts(toLocalStatusPart(current), event.remote);
}
