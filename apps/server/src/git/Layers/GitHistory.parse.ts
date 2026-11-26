import type { GitCommitAuthor, GitListCommitsResult } from "@bigbud/contracts";

/** Parsers for `git log` / `git show` records used by the History panel. */
export const COMMIT_LOG_FORMAT =
  "--format=%H%x00%h%x00%an%x00%aE%x00%aI%x00%s%x00%D%x00%(trailers:key=Co-authored-by,valueonly,separator=%x1f,unfold=true)%x1e";
export const DEFAULT_COMMIT_LIMIT = 50;
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

export function parseCommitSummaryRecords(
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

export function parseCommitDetails(stdout: string) {
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
