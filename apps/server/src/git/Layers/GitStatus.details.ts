import { Effect } from "effect";
import type { GitCommandError } from "@bigbud/contracts";

import type { GitStatusDetails } from "../Services/GitCore.ts";
import {
  parseBranchAb,
  parseNumstatEntries,
  parsePorcelainPath,
  createGitCommandError,
  isMissingGitCwdError,
} from "./GitCoreUtils.ts";
import type { GitHelpers } from "./GitCoreExecutor.ts";

const NON_REPOSITORY_STATUS_DETAILS = Object.freeze<GitStatusDetails>({
  isRepo: false,
  hasOriginRemote: false,
  isDefaultBranch: false,
  branch: null,
  upstreamRef: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
});

interface MakeStatusDetailsReaderInput {
  executeGit: GitHelpers["executeGit"];
  runGitStdout: GitHelpers["runGitStdout"];
  originRemoteExists: (cwd: string) => Effect.Effect<boolean, GitCommandError>;
  computeAheadCountAgainstBase: (
    cwd: string,
    branch: string,
  ) => Effect.Effect<number, GitCommandError>;
}

export function makeReadStatusDetails({
  executeGit,
  runGitStdout,
  originRemoteExists,
  computeAheadCountAgainstBase,
}: MakeStatusDetailsReaderInput) {
  return Effect.fn("readStatusDetails")(function* (
    cwd: string,
    operationPrefix: "GitCore.statusDetails" | "GitCore.statusDetailsLocal",
  ) {
    const statusResult = yield* executeGit(
      `${operationPrefix}.status`,
      cwd,
      ["status", "--porcelain=2", "--branch"],
      {
        allowNonZeroExit: true,
      },
    ).pipe(Effect.catchIf(isMissingGitCwdError, () => Effect.succeed(null)));

    if (statusResult === null) {
      return NON_REPOSITORY_STATUS_DETAILS;
    }

    if (statusResult.code !== 0) {
      const stderr = statusResult.stderr.trim();
      return yield* createGitCommandError(
        `${operationPrefix}.status`,
        cwd,
        ["status", "--porcelain=2", "--branch"],
        stderr || "git status failed",
      );
    }

    const [unstagedNumstatStdout, stagedNumstatStdout, defaultRefResult, hasOriginRemote] =
      yield* Effect.all(
        [
          runGitStdout(`${operationPrefix}.unstagedNumstat`, cwd, ["diff", "--numstat"]),
          runGitStdout(`${operationPrefix}.stagedNumstat`, cwd, ["diff", "--cached", "--numstat"]),
          executeGit(
            `${operationPrefix}.defaultRef`,
            cwd,
            ["symbolic-ref", "refs/remotes/origin/HEAD"],
            {
              allowNonZeroExit: true,
            },
          ),
          originRemoteExists(cwd).pipe(Effect.catch(() => Effect.succeed(false))),
        ],
        { concurrency: "unbounded" },
      );
    const statusStdout = statusResult.stdout;
    const defaultBranch =
      defaultRefResult.code === 0
        ? defaultRefResult.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
        : null;

    let branch: string | null = null;
    let upstreamRef: string | null = null;
    let aheadCount = 0;
    let behindCount = 0;
    let hasWorkingTreeChanges = false;
    const changedFilesWithoutNumstat = new Set<string>();

    for (const line of statusStdout.split(/\r?\n/g)) {
      if (line.startsWith("# branch.head ")) {
        const value = line.slice("# branch.head ".length).trim();
        branch = value.startsWith("(") ? null : value;
        continue;
      }
      if (line.startsWith("# branch.upstream ")) {
        const value = line.slice("# branch.upstream ".length).trim();
        upstreamRef = value.length > 0 ? value : null;
        continue;
      }
      if (line.startsWith("# branch.ab ")) {
        const value = line.slice("# branch.ab ".length).trim();
        const parsed = parseBranchAb(value);
        aheadCount = parsed.ahead;
        behindCount = parsed.behind;
        continue;
      }
      if (line.trim().length > 0 && !line.startsWith("#")) {
        hasWorkingTreeChanges = true;
        const pathValue = parsePorcelainPath(line);
        if (pathValue) changedFilesWithoutNumstat.add(pathValue);
      }
    }

    if (!upstreamRef && branch) {
      aheadCount = yield* computeAheadCountAgainstBase(cwd, branch).pipe(
        Effect.catch(() => Effect.succeed(0)),
      );
      behindCount = 0;
    }

    const stagedEntries = parseNumstatEntries(stagedNumstatStdout);
    const unstagedEntries = parseNumstatEntries(unstagedNumstatStdout);
    const fileStatMap = new Map<string, { insertions: number; deletions: number }>();
    for (const entry of [...stagedEntries, ...unstagedEntries]) {
      const existing = fileStatMap.get(entry.path) ?? { insertions: 0, deletions: 0 };
      existing.insertions += entry.insertions;
      existing.deletions += entry.deletions;
      fileStatMap.set(entry.path, existing);
    }

    let insertions = 0;
    let deletions = 0;
    const files = Array.from(fileStatMap.entries())
      .map(([filePath, stat]) => {
        insertions += stat.insertions;
        deletions += stat.deletions;
        return { path: filePath, insertions: stat.insertions, deletions: stat.deletions };
      })
      .toSorted((a, b) => a.path.localeCompare(b.path));

    for (const filePath of changedFilesWithoutNumstat) {
      if (fileStatMap.has(filePath)) continue;
      files.push({ path: filePath, insertions: 0, deletions: 0 });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));

    return {
      isRepo: true,
      hasOriginRemote,
      isDefaultBranch:
        branch !== null &&
        (branch === defaultBranch ||
          (defaultBranch === null && (branch === "main" || branch === "master"))),
      branch,
      upstreamRef,
      hasWorkingTreeChanges,
      workingTree: {
        files,
        insertions,
        deletions,
      },
      hasUpstream: upstreamRef !== null,
      aheadCount,
      behindCount,
    } satisfies GitStatusDetails;
  });
}
