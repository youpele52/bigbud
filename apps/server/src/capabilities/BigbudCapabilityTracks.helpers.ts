import type { CapabilityRisk, CapabilityTrack } from "./CapabilityCatalog.ts";

export const normalizeBrand = (text: string): string =>
  text.replaceAll("BigBud", "bigbud").replaceAll("Bigbud", "bigbud");

export const threadToolTrack = (input: {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly summary?: string;
  readonly triggers: ReadonlyArray<string>;
  readonly risk: CapabilityRisk;
  readonly workflow: string;
  readonly permissions: string;
  readonly examples: ReadonlyArray<string>;
  readonly antiPatterns: ReadonlyArray<string>;
  readonly relatedCapabilityIds?: ReadonlyArray<string>;
  readonly availability?: ReadonlyArray<string>;
}): CapabilityTrack => ({
  id: input.id,
  displayName: input.displayName,
  kind: "bigbud-tool",
  summary: normalizeBrand(input.summary ?? input.description),
  triggers: input.triggers,
  outcome: normalizeBrand(input.description),
  risk: input.risk,
  availability: input.availability ?? [
    "Available when the thread orchestration bridge is configured.",
  ],
  prerequisites: ["An active bigbud thread tool session."],
  relatedCapabilityIds: input.relatedCapabilityIds ?? [],
  source: "bigbud orchestration tool definition",
  trust: "bigbud",
  guide: {
    workflow: input.workflow,
    permissions: input.permissions,
    examples: input.examples,
    antiPatterns: input.antiPatterns,
  },
});
