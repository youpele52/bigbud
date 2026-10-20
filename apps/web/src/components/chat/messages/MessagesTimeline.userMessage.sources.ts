import type {
  ServerDiscoveredAgent,
  ServerDiscoveredSkill,
} from "@bigbud/contracts/server/server.providers.ts";
import { resolveDiscoveryEntry } from "@bigbud/shared/discoveryReference";

export type MentionKind = "path" | "agent" | "skill" | "plugin";
type RecordedSource = { provider?: string; sourcePath: string };

export function normalizeMentionName(
  mentionKind: MentionKind,
  rawValue: string,
  displayLabel: string,
): string {
  return mentionKind === "path"
    ? displayLabel.trim()
    : rawValue.replace(/^(?:agent|skill|plugin)::?/, "").trim() || displayLabel.trim();
}

export function buildReferencedSourcePathLookup(
  messageText: string,
): Map<string, RecordedSource[]> {
  const lookup = new Map<string, RecordedSource[]>();
  let key: string | null = null;
  let provider: string | undefined;
  for (const line of messageText.split(/\r?\n/)) {
    const reference = line.match(/^Referenced (agent|skill):\s*(.+)$/i);
    if (reference) {
      key = `${reference[1]!.toLowerCase()}:${reference[2]!.trim().toLowerCase()}`;
      provider = undefined;
      continue;
    }
    const providerMatch = line.match(/^Provider:\s*(.+)$/i);
    if (providerMatch) provider = providerMatch[1]!.trim();
    const sourcePathMatch = line.match(/^Source path:\s*(.+)$/i);
    if (key && sourcePathMatch) {
      const sources = lookup.get(key) ?? [];
      sources.push({ ...(provider ? { provider } : {}), sourcePath: sourcePathMatch[1]!.trim() });
      lookup.set(key, sources);
    }
  }
  return lookup;
}

function uniqueSourcePath(paths: ReadonlyArray<string | undefined>): string | null {
  const unique = [...new Set(paths.filter((value): value is string => !!value))];
  return unique.length === 1 ? unique[0]! : null;
}

/** Prefer recorded provenance; otherwise follow the same catalog precedence as invocation. */
export function resolveMentionSourcePath(input: {
  kind: "agent" | "skill";
  name: string;
  references: ReadonlyMap<string, ReadonlyArray<RecordedSource>>;
  agents: ReadonlyArray<ServerDiscoveredAgent>;
  skills: ReadonlyArray<ServerDiscoveredSkill>;
  preferredProvider: string | undefined;
}): string | null {
  const recorded = input.references.get(`${input.kind}:${input.name.trim().toLowerCase()}`);
  if (recorded?.length) {
    const unique = uniqueSourcePath(recorded.map((entry) => entry.sourcePath));
    if (unique) return unique;
    const bundled = recorded.filter((entry) => entry.provider === "bigbud");
    return uniqueSourcePath(
      (bundled.length
        ? bundled
        : recorded.filter((entry) => entry.provider === input.preferredProvider)
      ).map((entry) => entry.sourcePath),
    );
  }

  const entries = input.kind === "agent" ? input.agents : input.skills;
  const normalizedName = input.name.trim().toLowerCase();
  const canonicalName = entries.some((entry) => entry.name.trim().toLowerCase() === normalizedName);
  const candidates =
    canonicalName || input.kind === "agent"
      ? entries
      : input.skills
          .filter((entry) => entry.displayName?.trim().toLowerCase() === normalizedName)
          .map((entry) => ({
            id: entry.id,
            name: input.name,
            source: entry.source,
            provider: entry.provider,
            sourcePath: entry.sourcePath,
          }));
  const resolution = resolveDiscoveryEntry({
    entries: candidates,
    name: input.name,
    preferredProvider: input.preferredProvider,
  });
  if (resolution.status === "resolved") return resolution.entry.sourcePath ?? null;
  return resolution.status === "ambiguous"
    ? uniqueSourcePath(resolution.entries.map((entry) => entry.sourcePath))
    : null;
}
