import { BIGBUD_CAPABILITY_CATALOG } from "./BigbudCapabilityTracks.ts";
import type { CapabilityCatalog, VersionedCapabilityTrack } from "./CapabilityCatalog.ts";

export const CAPABILITY_SEARCH_RESULT_LIMIT = 12;
export const CAPABILITY_GUIDE_CHARACTER_LIMIT = 8_000;

export type CapabilityGuideSection = "summary" | "workflow" | "permissions" | "examples" | "full";

const queryTerms = (query: string): ReadonlyArray<string> =>
  query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 1)
    .slice(0, 12);

const scoreTrack = (track: VersionedCapabilityTrack, terms: ReadonlyArray<string>): number => {
  if (terms.length === 0) {
    return 1;
  }
  const weightedFields = [
    { text: `${track.id} ${track.displayName}`.toLowerCase(), weight: 4 },
    {
      text: [track.summary, track.outcome, ...track.triggers].join(" ").toLowerCase(),
      weight: 2,
    },
    { text: track.relatedCapabilityIds.join(" ").toLowerCase(), weight: 1 },
  ];
  return terms.reduce(
    (total, term) =>
      total +
      weightedFields.reduce(
        (termScore, field) => termScore + (field.text.includes(term) ? field.weight : 0),
        0,
      ),
    0,
  );
};

export function searchCapabilities(
  query: string,
  catalog: CapabilityCatalog | undefined = BIGBUD_CAPABILITY_CATALOG,
): {
  readonly catalogRevision: string;
  readonly matches: ReadonlyArray<{
    readonly id: string;
    readonly displayName: string;
    readonly summary: string;
    readonly uri: string;
    readonly risk: VersionedCapabilityTrack["risk"];
  }>;
} {
  const effectiveCatalog = catalog ?? BIGBUD_CAPABILITY_CATALOG;
  const terms = queryTerms(query);
  const matches = effectiveCatalog.tracks
    .map((track) => {
      return { track, score: scoreTrack(track, terms) };
    })
    .filter(({ score }) => score > 0)
    .toSorted(
      (left, right) => right.score - left.score || left.track.id.localeCompare(right.track.id),
    )
    .slice(0, CAPABILITY_SEARCH_RESULT_LIMIT)
    .map(({ track }) => ({
      id: track.id,
      displayName: track.displayName,
      summary: track.summary,
      uri: track.uri,
      risk: track.risk,
    }));
  return { catalogRevision: effectiveCatalog.revision, matches };
}

const serializeSummary = (track: VersionedCapabilityTrack): string =>
  [
    `# ${track.displayName}`,
    "",
    `- ID: ${track.id}`,
    `- URI: ${track.uri}`,
    `- Revision: ${track.revision}`,
    `- Kind: ${track.kind}`,
    `- Risk: ${track.risk}`,
    `- Source: ${track.source} (${track.trust})`,
    "",
    track.summary,
    "",
    `Use when: ${track.triggers.join(" ")}`,
    `Outcome: ${track.outcome}`,
    `Availability: ${track.availability.join(" ")}`,
    `Prerequisites: ${track.prerequisites.join(" ")}`,
  ].join("\n");

export function readCapabilityGuide(input: {
  readonly capabilityId: string;
  readonly section?: CapabilityGuideSection;
  readonly catalog?: CapabilityCatalog;
}): {
  readonly catalogRevision: string;
  readonly capabilityRevision: string;
  readonly section: CapabilityGuideSection;
  readonly content: string;
} {
  const capabilityId = input.capabilityId.trim().replace(/^bigbud:\/\/capabilities\//, "");
  const catalog = input.catalog ?? BIGBUD_CAPABILITY_CATALOG;
  const track = catalog.tracks.find((entry) => entry.id === capabilityId);
  if (!track) {
    throw new Error(`Unknown capability: ${input.capabilityId}`);
  }
  const section = input.section ?? "summary";
  const sectionContent = {
    summary: serializeSummary(track),
    workflow: `# ${track.displayName}: workflow\n\n${track.guide.workflow}`,
    permissions: [
      `# ${track.displayName}: permissions`,
      "",
      `Risk: ${track.risk}`,
      track.guide.permissions,
    ].join("\n"),
    examples: [
      `# ${track.displayName}: examples`,
      "",
      ...track.guide.examples.map((example) => `- ${example}`),
    ].join("\n"),
    full: [
      serializeSummary(track),
      "",
      "## Workflow",
      track.guide.workflow,
      "",
      "## Permissions and side effects",
      track.guide.permissions,
      "",
      "## Examples",
      ...track.guide.examples.map((example) => `- ${example}`),
      "",
      "## Anti-patterns",
      ...track.guide.antiPatterns.map((antiPattern) => `- ${antiPattern}`),
      "",
      `## Related capabilities\n${track.relatedCapabilityIds.join(", ") || "None"}`,
    ].join("\n"),
  } satisfies Record<CapabilityGuideSection, string>;
  const content = sectionContent[section];
  if (content.length > CAPABILITY_GUIDE_CHARACTER_LIMIT) {
    throw new Error(`Capability guide exceeds ${CAPABILITY_GUIDE_CHARACTER_LIMIT} characters.`);
  }
  return {
    catalogRevision: catalog.revision,
    capabilityRevision: track.revision,
    section,
    content,
  };
}
