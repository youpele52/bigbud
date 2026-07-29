import {
  estimateCapabilityTokens,
  LP_HARD_TOKEN_LIMIT,
  type CapabilityCatalog,
  type CapabilityPlaylistContext,
  SKIT_HARD_TOKEN_LIMIT,
} from "./CapabilityCatalog.ts";

const assertWithinBudget = (label: string, text: string, limit: number): string => {
  const tokens = estimateCapabilityTokens(text);
  if (tokens > limit) {
    throw new Error(`${label} exceeds its ${limit}-token hard limit (${tokens} estimated).`);
  }
  return text;
};

export const BIGBUD_CAPABILITY_CATALOG_PROTOCOL =
  "bigbud capability Tracks provide bounded operating guidance. Use search_capabilities to discover relevant capabilities and read_capability_guide to load a Track. Operational tools retain their typed schemas and permission rules. Standalone delegated threads do not inherit the parent transcript, so delegated tasks must be self-contained.";

export function serializeCapabilityLp(input: {
  readonly catalog: CapabilityCatalog;
  readonly context: CapabilityPlaylistContext;
  readonly capabilityIds?: ReadonlyArray<string>;
}): string {
  const selectedIds = input.capabilityIds ? new Set(input.capabilityIds) : null;
  const tracks = selectedIds
    ? input.catalog.tracks.filter((track) => selectedIds.has(track.id))
    : input.catalog.tracks;
  const identity = [
    `- thread: ${input.context.threadTitle} (${input.context.threadId})`,
    input.context.provider ? `- provider: ${input.context.provider}` : null,
    input.context.model ? `- model: ${input.context.model}` : null,
    input.context.runtimeMode ? `- runtime: ${input.context.runtimeMode}` : null,
    input.context.role ? `- context role: ${input.context.role}` : null,
  ].filter((line): line is string => line !== null);
  const coreTracks = tracks.filter((track) => track.kind === "bigbud-tool");
  const optionalTracks = tracks.filter((track) => track.kind !== "bigbud-tool");
  const optionalGroups = new Map<string, number>();
  for (const track of optionalTracks) {
    optionalGroups.set(track.kind, (optionalGroups.get(track.kind) ?? 0) + 1);
  }
  const cards = [
    ...coreTracks.map((track) => `- ${track.id}: ${track.summary} Track: ${track.uri}`),
    ...[...optionalGroups].map(
      ([kind, count]) =>
        `- ${kind} family (${count} available): use search_capabilities to find individual Tracks.`,
    ),
  ];
  const text = [
    "<bigbud_capability_lp>",
    `Catalog revision: ${input.catalog.revision}`,
    BIGBUD_CAPABILITY_CATALOG_PROTOCOL,
    "",
    "Session:",
    ...identity,
    "",
    "Capabilities:",
    ...cards,
    "</bigbud_capability_lp>",
  ].join("\n");
  return assertWithinBudget("Capability LP", text, LP_HARD_TOKEN_LIMIT);
}

export function serializeCapabilitySkit(catalogRevision: string): string {
  const text = [
    "<bigbud_capability_skit>",
    `Catalog revision: ${catalogRevision}.`,
    "Tracks remain available: use search_capabilities, then read_capability_guide for bounded guidance.",
    "Standalone delegated threads need self-contained tasks because they do not inherit the parent transcript.",
    "</bigbud_capability_skit>",
  ].join("\n");
  return assertWithinBudget("Capability Skit", text, SKIT_HARD_TOKEN_LIMIT);
}

export function serializeCapabilityDelta(catalogRevision: string, summary: string): string {
  const text = [
    "<bigbud_capability_delta>",
    `Catalog revision: ${catalogRevision}.`,
    summary,
    "Use search_capabilities to refresh discovery and read_capability_guide before relying on changed availability.",
    "</bigbud_capability_delta>",
  ].join("\n");
  return assertWithinBudget("Capability Delta", text, SKIT_HARD_TOKEN_LIMIT);
}
