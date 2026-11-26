import { Effect } from "effect";

import {
  GIT_COMMIT_FILE_DIFF_LARGE_LIMIT_BYTES,
  GIT_COMMIT_FILE_DIFF_LIMIT_BYTES,
  type GitCommitFileStat,
  type GitGetCommitDetailsResult,
  type GitGetCommitFileDiffResult,
} from "@bigbud/contracts";
import type { GitCoreShape } from "../Services/GitCore.ts";
import type { GitHelpers } from "./GitCoreExecutor.ts";
import { createGitCommandError } from "./GitCoreUtils.ts";
import { parseCommitDetails } from "./GitHistory.parse.ts";

/**
 * One commit for the History panel, shaped like GitHub Desktop: the summary and the changed-file
 * list come back together, and each file's patch is read on demand with a per-file byte cap. A
 * file over the cap is a typed `tooLarge` result, never a failure of the whole commit.
 *
 * @module GitHistory.commit
 */
export const COMMIT_SUMMARY_FORMAT =
  "--format=%H%x00%h%x00%an%x00%aE%x00%aI%x00%s%x00%D%x00%B%x00%P%x00%(trailers:key=Co-authored-by,valueonly,separator=%x1f,unfold=true)";
export const COMMIT_NUMSTAT_ARGS = [
  "show",
  "--format=",
  "--numstat",
  "-z",
  "--find-renames",
  "--find-copies",
] as const;
export const COMMIT_FILE_DIFF_ARGS = [
  "show",
  "--format=",
  "--find-renames",
  "--find-copies",
  "--no-ext-diff",
  "--no-textconv",
] as const;
export const LITERAL_PATHSPEC = ":(top,literal)";

/** `git show --numstat -z`: `ins\tdel\tpath\0`, or `ins\tdel\t\0old\0new\0` for a rename/copy. */
export function parseCommitNumstatZ(stdout: string): GitCommitFileStat[] {
  const fields = stdout.split("\0");
  const files: GitCommitFileStat[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index]!.replace(/^\n+/u, "");
    if (record.length === 0) continue;
    const [added = "", deleted = "", path = ""] = record.split("\t");
    const binary = added === "-" && deleted === "-";
    const counts = {
      insertions: binary ? 0 : Number.parseInt(added, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(deleted, 10) || 0,
      ...(binary ? { binary: true } : {}),
    };
    if (path.length > 0) {
      files.push({ path, ...counts });
      continue;
    }
    const oldPath = fields[index + 1];
    const newPath = fields[index + 2];
    index += 2;
    if (!oldPath || !newPath) continue;
    files.push({ path: newPath, oldPath, ...counts });
  }
  return files;
}

function refuseRevision(operation: string, cwd: string, commit: string) {
  return createGitCommandError(operation, cwd, [commit], "Invalid commit reference.");
}

export function makeGitCommitOps(helpers: GitHelpers) {
  const { executeGit, runGitStdout } = helpers;

  const getCommitDetails: GitCoreShape["getCommitDetails"] = Effect.fn("getCommitDetails")(
    function* (input) {
      if (input.commit.startsWith("-")) {
        return yield* refuseRevision("GitCore.getCommitDetails", input.cwd, input.commit);
      }
      const [detailsStdout, numstatStdout] = yield* Effect.all(
        [
          runGitStdout("GitCore.getCommitDetails.summary", input.cwd, [
            "show",
            "-s",
            COMMIT_SUMMARY_FORMAT,
            input.commit,
          ]),
          runGitStdout("GitCore.getCommitDetails.numstat", input.cwd, [
            ...COMMIT_NUMSTAT_ARGS,
            input.commit,
            "--",
          ]),
        ],
        { concurrency: "unbounded" },
      );
      return {
        commit: { ...parseCommitDetails(detailsStdout), files: parseCommitNumstatZ(numstatStdout) },
      } satisfies GitGetCommitDetailsResult;
    },
  );

  const getCommitFileDiff: GitCoreShape["getCommitFileDiff"] = Effect.fn("getCommitFileDiff")(
    function* (input) {
      if (input.commit.startsWith("-")) {
        return yield* refuseRevision("GitCore.getCommitFileDiff", input.cwd, input.commit);
      }
      const limitBytes =
        input.limit === "large"
          ? GIT_COMMIT_FILE_DIFF_LARGE_LIMIT_BYTES
          : GIT_COMMIT_FILE_DIFF_LIMIT_BYTES;
      const paths = [...(input.oldPath ? [input.oldPath] : []), input.path];
      const result = yield* executeGit(
        "GitCore.getCommitFileDiff",
        input.cwd,
        [
          ...COMMIT_FILE_DIFF_ARGS,
          input.commit,
          "--",
          ...paths.map((path) => `${LITERAL_PATHSPEC}${path}`),
        ],
        { maxOutputBytes: limitBytes, truncateOutputAtMaxBytes: true },
      );
      return (
        result.stdoutTruncated
          ? { path: input.path, diff: null, tooLarge: true, limitBytes }
          : { path: input.path, diff: result.stdout, tooLarge: false, limitBytes }
      ) satisfies GitGetCommitFileDiffResult;
    },
  );

  return { getCommitDetails, getCommitFileDiff };
}
