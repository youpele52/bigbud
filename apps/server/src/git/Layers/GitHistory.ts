import { Effect } from "effect";

import type {
  GitCommitAuthor,
  GitGetCommitDetailsResult,
  GitListCommitsResult,
  GitReadWorkingTreeDiffResult,
} from "@bigbud/contracts";
import { createGitCommandError, parseNumstatEntries, parsePorcelainPath } from "./GitCoreUtils.ts";
import type { GitHelpers } from "./GitCoreExecutor.ts";
import type { GitCoreShape } from "../Services/GitCore.ts";

const DEFAULT_COMMIT_LIMIT = 50;
const FIELD_SEPARATOR = "\u0000";
const AUTHOR_SEPARATOR = "\u001f";
const RECORD_SEPARATOR = "\u001e";

function normalizeAuthorKey(author: GitCommitAuthor): string {
  const normalizedEmail = author.email?.trim().toLowerCase() ?? "";
  const normalizedName = author.name.trim().toLowerCase();
  return normalizedEmail.length > 0 ? `email:${normalizedEmail}` : `name:${normalizedName}`;
}

function parseCommitAuthor(rawName: string, rawEmail?: string): GitCommitAuthor | null {
  const name = rawName.trim();
  const email = rawEmail?.trim() ?? "";
  if (name.length === 0) {
    return null;
  }

  return {
    name,
    email: email.length > 0 ? email : null,
  };
}

function parseCoAuthorTrailer(rawTrailer: string): GitCommitAuthor | null {
  const trimmed = rawTrailer.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const match = /^(.*?)\s*<([^<>]+)>$/.exec(trimmed);
  if (!match) {
    return parseCommitAuthor(trimmed);
  }

  const [, name = "", email = ""] = match;
  return parseCommitAuthor(name, email);
}

function buildCommitAuthors(input: {
  authorName: string;
  authorEmail?: string;
  coAuthorsRaw?: string;
}): Array<GitCommitAuthor> {
  const authors: Array<GitCommitAuthor> = [];
  const seenKeys = new Set<string>();

  const appendAuthor = (author: GitCommitAuthor | null) => {
    if (!author) {
      return;
    }
    const key = normalizeAuthorKey(author);
    if (seenKeys.has(key)) {
      return;
    }
    seenKeys.add(key);
    authors.push(author);
  };

  appendAuthor(parseCommitAuthor(input.authorName, input.authorEmail));

  for (const entry of (input.coAuthorsRaw ?? "").split(AUTHOR_SEPARATOR)) {
    appendAuthor(parseCoAuthorTrailer(entry));
  }

  return authors;
}

function parseCommitSummaryRecords(
  stdout: string,
  unpushedCommitShas: ReadonlySet<string>,
): GitListCommitsResult["commits"] {
  return stdout
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .flatMap((record) => {
      const [
        sha = "",
        shortSha = "",
        authorName = "",
        authorEmail = "",
        authoredAt = "",
        subject = "",
        decorations = "",
        coAuthorsRaw = "",
      ] = record.split(FIELD_SEPARATOR);
      if (!sha || !shortSha || !authorName || !authoredAt || !subject) {
        return [];
      }
      return [
        {
          sha,
          shortSha,
          authors: buildCommitAuthors({ authorName, authorEmail, coAuthorsRaw }),
          authoredAt,
          subject,
          isPushed: !unpushedCommitShas.has(sha),
          tags: parseGitTagDecorations(decorations),
        },
      ];
    });
}

function parseGitTagDecorations(decorations: string): string[] {
  return [
    ...new Set(
      decorations
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.startsWith("tag: "))
        .map((entry) => entry.slice("tag: ".length).trim())
        .filter((entry) => entry.length > 0),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

function parseCommitDetails(stdout: string) {
  const [
    sha = "",
    shortSha = "",
    authorName = "",
    authorEmail = "",
    authoredAt = "",
    subject = "",
    decorations = "",
    body = "",
    parentsRaw = "",
    coAuthorsRaw = "",
  ] = stdout.split(FIELD_SEPARATOR);
  return {
    sha,
    shortSha,
    authors: buildCommitAuthors({ authorName, authorEmail, coAuthorsRaw }),
    authoredAt,
    subject,
    tags: parseGitTagDecorations(decorations),
    body,
    parents: parentsRaw
      .split(" ")
      .map((parent) => parent.trim())
      .filter((parent) => parent.length > 0),
  };
}

export interface GitHistoryOps {
  listCommits: GitCoreShape["listCommits"];
  getCommitDetails: GitCoreShape["getCommitDetails"];
  readWorkingTreeDiff: GitCoreShape["readWorkingTreeDiff"];
}

export function makeGitHistoryOps(helpers: GitHelpers): GitHistoryOps {
  const { executeGit, runGitStdout } = helpers;

  const resolveUnpushedCommitShas = Effect.fn("resolveUnpushedCommitShas")(function* (cwd: string) {
    const upstreamResult = yield* executeGit(
      "GitCore.listCommits.upstreamRef",
      cwd,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      { allowNonZeroExit: true },
    );

    if (upstreamResult.code !== 0) {
      return new Set<string>();
    }

    const upstreamRef = upstreamResult.stdout.trim();
    if (!upstreamRef) {
      return new Set<string>();
    }

    const revListStdout = yield* runGitStdout("GitCore.listCommits.unpushed", cwd, [
      "rev-list",
      `${upstreamRef}..HEAD`,
    ]).pipe(Effect.catch(() => Effect.succeed("")));

    return new Set(
      revListStdout
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
  });

  const readUntrackedPaths = Effect.fn("readUntrackedPaths")(function* (
    cwd: string,
    relativePath?: string,
  ) {
    const statusArgs = [
      "status",
      "--porcelain=1",
      "--untracked-files=all",
      "--",
      ...(relativePath ? [relativePath] : []),
    ];
    const stdout = yield* runGitStdout("GitCore.readWorkingTreeDiff.status", cwd, statusArgs, true);
    return stdout
      .split(/\r?\n/g)
      .filter((line) => line.startsWith("?? "))
      .flatMap((line) => {
        const filePath = parsePorcelainPath(line);
        return filePath ? [filePath] : [];
      });
  });

  const hasHeadCommit = Effect.fn("hasHeadCommit")(function* (cwd: string) {
    const result = yield* executeGit(
      "GitCore.readWorkingTreeDiff.hasHead",
      cwd,
      ["rev-parse", "--verify", "HEAD"],
      {
        allowNonZeroExit: true,
      },
    );
    return result.code === 0;
  });

  const readTrackedWorkingTreeDiff = Effect.fn("readTrackedWorkingTreeDiff")(function* (
    cwd: string,
    relativePath?: string,
  ) {
    const hasHead = yield* hasHeadCommit(cwd);
    if (hasHead) {
      return yield* runGitStdout(
        "GitCore.readWorkingTreeDiff.trackedAgainstHead",
        cwd,
        ["diff", "--find-renames", "HEAD", "--", ...(relativePath ? [relativePath] : [])],
        true,
      );
    }

    const [stagedPatch, unstagedPatch] = yield* Effect.all(
      [
        runGitStdout(
          "GitCore.readWorkingTreeDiff.initial.staged",
          cwd,
          ["diff", "--cached", "--find-renames", "--", ...(relativePath ? [relativePath] : [])],
          true,
        ),
        runGitStdout(
          "GitCore.readWorkingTreeDiff.initial.unstaged",
          cwd,
          ["diff", "--find-renames", "--", ...(relativePath ? [relativePath] : [])],
          true,
        ),
      ],
      { concurrency: "unbounded" },
    );

    return [stagedPatch.trimEnd(), unstagedPatch.trimEnd()].filter(Boolean).join("\n");
  });

  const readUntrackedFileDiff = Effect.fn("readUntrackedFileDiff")(function* (
    cwd: string,
    relativePath: string,
  ) {
    const args = ["diff", "--no-index", "/dev/null", relativePath] as const;
    const result = yield* executeGit("GitCore.readWorkingTreeDiff.untrackedFile", cwd, args, {
      allowNonZeroExit: true,
    });

    if (result.code === 1 || result.code === 0) {
      return result.stdout.trimEnd();
    }

    return yield* createGitCommandError(
      "GitCore.readWorkingTreeDiff.untrackedFile",
      cwd,
      args,
      result.stderr.trim() || "git diff --no-index failed",
    );
  });

  const listCommits: GitCoreShape["listCommits"] = Effect.fn("listCommits")(function* (input) {
    const limit = input.limit ?? DEFAULT_COMMIT_LIMIT;
    const skip = input.cursor ?? 0;
    const args = [
      "log",
      `--max-count=${limit + 1}`,
      ...(skip > 0 ? [`--skip=${skip}`] : []),
      `--format=%H%x00%h%x00%an%x00%aE%x00%aI%x00%s%x00%D%x00%(trailers:key=Co-authored-by,valueonly,separator=%x1f,unfold=true)%x1e`,
    ];
    const result = yield* executeGit("GitCore.listCommits", input.cwd, args, {
      allowNonZeroExit: true,
    });

    if (result.code !== 0) {
      const detail = result.stderr.toLowerCase();
      if (
        detail.includes("does not have any commits yet") ||
        detail.includes("your current branch")
      ) {
        return { commits: [], nextCursor: null } satisfies GitListCommitsResult;
      }
      return yield* createGitCommandError(
        "GitCore.listCommits",
        input.cwd,
        args,
        result.stderr.trim() || "git log failed",
      );
    }

    const unpushedCommitShas = yield* resolveUnpushedCommitShas(input.cwd);

    const commits = parseCommitSummaryRecords(result.stdout, unpushedCommitShas);
    const pageCommits = commits.slice(0, limit);

    return {
      commits: pageCommits,
      nextCursor: commits.length > limit ? skip + limit : null,
    } satisfies GitListCommitsResult;
  });

  const getCommitDetails: GitCoreShape["getCommitDetails"] = Effect.fn("getCommitDetails")(
    function* (input) {
      const [detailsStdout, numstatStdout, diff] = yield* Effect.all(
        [
          runGitStdout("GitCore.getCommitDetails.summary", input.cwd, [
            "show",
            "-s",
            `--format=%H%x00%h%x00%an%x00%aE%x00%aI%x00%s%x00%D%x00%B%x00%P%x00%(trailers:key=Co-authored-by,valueonly,separator=%x1f,unfold=true)`,
            input.commit,
          ]),
          runGitStdout("GitCore.getCommitDetails.numstat", input.cwd, [
            "show",
            "--format=",
            "--numstat",
            "--find-renames",
            "--find-copies",
            input.commit,
          ]),
          runGitStdout("GitCore.getCommitDetails.diff", input.cwd, [
            "show",
            "--format=",
            "--find-renames",
            "--find-copies",
            input.commit,
          ]),
        ],
        { concurrency: "unbounded" },
      );

      const summary = parseCommitDetails(detailsStdout);
      return {
        commit: {
          ...summary,
          files: parseNumstatEntries(numstatStdout),
          diff,
        },
      } satisfies GitGetCommitDetailsResult;
    },
  );

  const readWorkingTreeDiff: GitCoreShape["readWorkingTreeDiff"] = Effect.fn("readWorkingTreeDiff")(
    function* (input) {
      const [trackedDiff, untrackedPaths] = yield* Effect.all(
        [
          readTrackedWorkingTreeDiff(input.cwd, input.path),
          readUntrackedPaths(input.cwd, input.path),
        ],
        { concurrency: "unbounded" },
      );

      const untrackedDiffs = yield* Effect.all(
        untrackedPaths.map((relativePath) => readUntrackedFileDiff(input.cwd, relativePath)),
        { concurrency: "unbounded" },
      );

      return {
        diff: [trackedDiff.trimEnd(), ...untrackedDiffs.map((patch) => patch.trimEnd())]
          .filter((patch) => patch.length > 0)
          .join("\n"),
      } satisfies GitReadWorkingTreeDiffResult;
    },
  );

  return {
    listCommits,
    getCommitDetails,
    readWorkingTreeDiff,
  };
}
