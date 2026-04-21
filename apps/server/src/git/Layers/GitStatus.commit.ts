/**
 * GitStatus.commit - Commit preparation, commit creation, and range context reads.
 *
 * @module GitStatus.commit
 */
import { Effect } from "effect";

import { type GitCoreShape, type GitCommitOptions } from "../Services/GitCore.ts";
import { type GitHelpers } from "./GitCoreExecutor.ts";

const PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES = 49_000;
const RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES = 59_000;

export function makeCommitOps(helpers: GitHelpers) {
  const { executeGit, runGit, runGitStdout, runGitStdoutWithOptions } = helpers;

  const prepareCommitContext: GitCoreShape["prepareCommitContext"] = Effect.fn(
    "prepareCommitContext",
  )(function* (cwd, filePaths) {
    if (filePaths && filePaths.length > 0) {
      yield* runGit("GitCore.prepareCommitContext.reset", cwd, ["reset"]).pipe(
        Effect.catch(() => Effect.void),
      );
      yield* runGit("GitCore.prepareCommitContext.addSelected", cwd, [
        "add",
        "-A",
        "--",
        ...filePaths,
      ]);
    } else {
      yield* runGit("GitCore.prepareCommitContext.addAll", cwd, ["add", "-A"]);
    }

    const stagedSummary = yield* runGitStdout("GitCore.prepareCommitContext.stagedSummary", cwd, [
      "diff",
      "--cached",
      "--name-status",
    ]).pipe(Effect.map((stdout) => stdout.trim()));
    if (stagedSummary.length === 0) {
      return null;
    }

    const stagedPatch = yield* runGitStdoutWithOptions(
      "GitCore.prepareCommitContext.stagedPatch",
      cwd,
      ["diff", "--cached", "--patch", "--minimal"],
      {
        maxOutputBytes: PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES,
        truncateOutputAtMaxBytes: true,
      },
    );

    return {
      stagedSummary,
      stagedPatch,
    };
  });

  const commit: GitCoreShape["commit"] = Effect.fn("commit")(function* (
    cwd,
    subject,
    body,
    options?: GitCommitOptions,
  ) {
    const args = ["commit", "-m", subject];
    const trimmedBody = body.trim();
    if (trimmedBody.length > 0) {
      args.push("-m", trimmedBody);
    }
    const progress =
      options?.progress?.onOutputLine === undefined
        ? options?.progress
        : {
            ...options.progress,
            onStdoutLine: (line: string) =>
              options.progress?.onOutputLine?.({ stream: "stdout", text: line }) ?? Effect.void,
            onStderrLine: (line: string) =>
              options.progress?.onOutputLine?.({ stream: "stderr", text: line }) ?? Effect.void,
          };
    yield* executeGit("GitCore.commit.commit", cwd, args, {
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(progress ? { progress } : {}),
    }).pipe(Effect.asVoid);
    const commitSha = yield* runGitStdout("GitCore.commit.revParseHead", cwd, [
      "rev-parse",
      "HEAD",
    ]).pipe(Effect.map((stdout) => stdout.trim()));

    return { commitSha };
  });

  const readRangeContext: GitCoreShape["readRangeContext"] = Effect.fn("readRangeContext")(
    function* (cwd, baseBranch) {
      const range = `${baseBranch}..HEAD`;
      const [commitSummary, diffSummary, diffPatch] = yield* Effect.all(
        [
          runGitStdoutWithOptions(
            "GitCore.readRangeContext.log",
            cwd,
            ["log", "--oneline", range],
            {
              maxOutputBytes: RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES,
              truncateOutputAtMaxBytes: true,
            },
          ),
          runGitStdoutWithOptions(
            "GitCore.readRangeContext.diffStat",
            cwd,
            ["diff", "--stat", range],
            {
              maxOutputBytes: RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES,
              truncateOutputAtMaxBytes: true,
            },
          ),
          runGitStdoutWithOptions(
            "GitCore.readRangeContext.diffPatch",
            cwd,
            ["diff", "--patch", "--minimal", range],
            {
              maxOutputBytes: RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES,
              truncateOutputAtMaxBytes: true,
            },
          ),
        ],
        { concurrency: "unbounded" },
      );

      return {
        commitSummary,
        diffSummary,
        diffPatch,
      };
    },
  );

  const readConfigValue: GitCoreShape["readConfigValue"] = (cwd, key) =>
    runGitStdout("GitCore.readConfigValue", cwd, ["config", "--get", key], true).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.map((trimmed) => (trimmed.length > 0 ? trimmed : null)),
    );

  return {
    prepareCommitContext,
    commit,
    readRangeContext,
    readConfigValue,
  };
}
