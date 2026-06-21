export interface ParsedRelease {
  version: string;
  publishedAt: string;
  isoDate: string | null;
  sections: string[];
}

export interface ChangelogSummary {
  latestRelease: ParsedRelease | null;
  releaseCount: number;
  dateRangeLabel: string | null;
  recurringTopics: string[];
}

const RELEASE_HEADING_PATTERN = /^##\s+v([^\s]+)\s+\(([^)]+)\)$/gm;
const SECTION_HEADING_PATTERN = /^###\s+(.+)$/gm;

function parseIsoDate(dateLabel: string): string | null {
  const parsed = new Date(dateLabel);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function getRecurringTopics(releases: ParsedRelease[]): string[] {
  const counts = new Map<string, number>();

  for (const release of releases) {
    for (const section of release.sections) {
      counts.set(section, (counts.get(section) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .toSorted((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }

      return left[0].localeCompare(right[0]);
    })
    .slice(0, 6)
    .map(([topic]) => topic);
}

export function parseChangelogReleases(markdown: string): ParsedRelease[] {
  const headingMatches = [...markdown.matchAll(RELEASE_HEADING_PATTERN)];

  return headingMatches.map((match, index) => {
    const startIndex = match.index ?? 0;
    const endIndex = headingMatches[index + 1]?.index ?? markdown.length;
    const releaseBody = markdown.slice(startIndex, endIndex);
    const sections = [...releaseBody.matchAll(SECTION_HEADING_PATTERN)].map((sectionMatch) =>
      sectionMatch[1].trim(),
    );

    return {
      version: `v${match[1]}`,
      publishedAt: match[2].trim(),
      isoDate: parseIsoDate(match[2].trim()),
      sections,
    };
  });
}

export function summarizeChangelog(markdown: string): ChangelogSummary {
  const releases = parseChangelogReleases(markdown);
  const latestRelease = releases[0] ?? null;
  const oldestRelease = releases.at(-1) ?? null;
  const dateRangeLabel =
    latestRelease && oldestRelease
      ? `${oldestRelease.publishedAt} to ${latestRelease.publishedAt}`
      : null;

  return {
    latestRelease,
    releaseCount: releases.length,
    dateRangeLabel,
    recurringTopics: getRecurringTopics(releases),
  };
}
