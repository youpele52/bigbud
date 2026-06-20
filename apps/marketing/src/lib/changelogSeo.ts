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

export function buildChangelogFaq(
  summary: ChangelogSummary,
): Array<{ question: string; answer: string }> {
  const latestReleaseLabel = summary.latestRelease
    ? `${summary.latestRelease.version} on ${summary.latestRelease.publishedAt}`
    : "the latest release";
  const latestTopics =
    summary.latestRelease?.sections.slice(0, 4).join(", ") ??
    "AI workspace improvements, provider support, and reliability fixes";
  const recurringTopics =
    summary.recurringTopics.slice(0, 5).join(", ") ||
    "providers, browser tooling, git workflows, automation, and reliability";

  return [
    {
      question: "What is bigbud?",
      answer:
        "bigbud is an AI workspace that brings chats, files, browser research, git workflows, and multiple AI providers into one place so you can keep work moving without constantly switching tools.",
    },
    {
      question: "What is included in the bigbud changelog?",
      answer: `The bigbud changelog tracks ${summary.releaseCount} documented releases${summary.dateRangeLabel ? ` from ${summary.dateRangeLabel}` : ""}, covering new features, UI changes, provider updates, workflow improvements, and reliability fixes.`,
    },
    {
      question: "What is new in the latest bigbud release?",
      answer: `The latest documented release is ${latestReleaseLabel}. It highlights ${latestTopics}, showing that bigbud is actively shipping workflow, platform, and usability improvements.`,
    },
    {
      question: "What kinds of updates does bigbud ship most often?",
      answer: `Across the changelog, recurring update areas include ${recurringTopics}. That pattern shows a product focus on multi-provider AI work, in-app tooling, and predictable day-to-day workflows.`,
    },
  ];
}
