import { createHash } from "node:crypto";

export const CAPABILITY_URI_PREFIX = "bigbud://capabilities/";
export const LP_TARGET_TOKEN_LIMIT = 1_200;
export const LP_HARD_TOKEN_LIMIT = 2_000;
export const SKIT_TARGET_TOKEN_LIMIT = 100;
export const SKIT_HARD_TOKEN_LIMIT = 200;

export type CapabilityKind =
  | "bigbud-tool"
  | "built-in-tool"
  | "skill"
  | "agent"
  | "mcp-server"
  | "mcp-tool"
  | "capability-family";

export type CapabilityRisk = "read-only" | "reversible-write" | "mutating";
export type CapabilityTrust = "bigbud" | "provider" | "local" | "third-party";

export interface CapabilityTrack {
  readonly id: string;
  readonly displayName: string;
  readonly kind: CapabilityKind;
  readonly summary: string;
  readonly triggers: ReadonlyArray<string>;
  readonly outcome: string;
  readonly risk: CapabilityRisk;
  readonly availability: ReadonlyArray<string>;
  readonly prerequisites: ReadonlyArray<string>;
  readonly relatedCapabilityIds: ReadonlyArray<string>;
  readonly source: string;
  readonly trust: CapabilityTrust;
  readonly guide: {
    readonly workflow: string;
    readonly permissions: string;
    readonly examples: ReadonlyArray<string>;
    readonly antiPatterns: ReadonlyArray<string>;
  };
}

export interface VersionedCapabilityTrack extends CapabilityTrack {
  readonly uri: string;
  readonly revision: string;
}

export interface CapabilityCatalog {
  readonly tracks: ReadonlyArray<VersionedCapabilityTrack>;
  readonly revision: string;
}

export interface CapabilityPlaylistContext {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly provider?: string;
  readonly model?: string;
  readonly runtimeMode?: string;
  readonly role?: "main" | "branch" | "delegated-child";
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const hash = (value: unknown): string =>
  createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16);

export const capabilityUri = (id: string): string => `${CAPABILITY_URI_PREFIX}${id}`;

export function createCapabilityCatalog(tracks: ReadonlyArray<CapabilityTrack>): CapabilityCatalog {
  const versioned = tracks
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .map((track) => {
      const sourceTrack: CapabilityTrack = {
        id: track.id,
        displayName: track.displayName,
        kind: track.kind,
        summary: track.summary,
        triggers: track.triggers,
        outcome: track.outcome,
        risk: track.risk,
        availability: track.availability,
        prerequisites: track.prerequisites,
        relatedCapabilityIds: track.relatedCapabilityIds,
        source: track.source,
        trust: track.trust,
        guide: track.guide,
      };
      return {
        id: sourceTrack.id,
        displayName: sourceTrack.displayName,
        kind: sourceTrack.kind,
        summary: sourceTrack.summary,
        triggers: sourceTrack.triggers,
        outcome: sourceTrack.outcome,
        risk: sourceTrack.risk,
        availability: sourceTrack.availability,
        prerequisites: sourceTrack.prerequisites,
        relatedCapabilityIds: sourceTrack.relatedCapabilityIds,
        source: sourceTrack.source,
        trust: sourceTrack.trust,
        guide: sourceTrack.guide,
        uri: capabilityUri(sourceTrack.id),
        revision: hash(sourceTrack),
      };
    });
  return {
    tracks: versioned,
    revision: hash(versioned.map(({ id, revision }) => ({ id, revision }))),
  };
}

export function estimateCapabilityTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function validateCapabilityCatalog(catalog: CapabilityCatalog): ReadonlyArray<string> {
  const errors: Array<string> = [];
  const ids = new Set<string>();

  for (const track of catalog.tracks) {
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(track.id)) {
      errors.push(`Invalid capability ID: ${track.id}`);
    }
    if (ids.has(track.id)) {
      errors.push(`Duplicate capability ID: ${track.id}`);
    }
    ids.add(track.id);
    if (track.uri !== capabilityUri(track.id)) {
      errors.push(`Invalid Track URI for ${track.id}`);
    }
    if (estimateCapabilityTokens(track.summary) > 60) {
      errors.push(`LP summary exceeds 60 estimated tokens: ${track.id}`);
    }
    if (/BigBud|Bigbud|bigBud/.test(stableJson(track))) {
      errors.push(`User-facing Track text must spell bigbud lowercase: ${track.id}`);
    }
  }

  for (const track of catalog.tracks) {
    for (const relatedId of track.relatedCapabilityIds) {
      if (!ids.has(relatedId)) {
        errors.push(`Missing related capability ${relatedId} from ${track.id}`);
      }
    }
  }
  return errors;
}
