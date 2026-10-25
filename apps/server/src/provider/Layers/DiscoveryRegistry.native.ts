import type {
  ServerProvider,
  ServerDiscoveredAgent,
  ServerDiscoveredSkill,
  ServerDiscoveryCatalog,
} from "@bigbud/contracts/server/server.providers.ts";
import type { ParsedDiscoveryFileEntry } from "./DiscoveryRegistry.parse.ts";

type SourceFile = ParsedDiscoveryFileEntry & { readonly systemPromptHash?: string | undefined };

function verifiedAgentSource(
  agent: NonNullable<ServerProvider["nativeAgents"]>[number],
  files: ReadonlyArray<SourceFile | null>,
): Pick<ServerDiscoveredAgent, "source" | "sourcePath"> | undefined {
  if (!agent.systemPromptHash) return undefined;
  const names = new Set([agent.id.trim().toLowerCase(), agent.name.trim().toLowerCase()]);
  const matches = new Map<string, ServerDiscoveredAgent>();
  for (const file of files) {
    if (
      file?.kind !== "agent" ||
      file.entry.provider !== "opencode" ||
      file.systemPromptHash !== agent.systemPromptHash ||
      !file.entry.sourcePath ||
      !names.has(file.entry.name.trim().toLowerCase())
    )
      continue;
    matches.set(file.entry.sourcePath, file.entry);
  }
  if (matches.size !== 1) return undefined;
  const source = matches.values().next().value!;
  return { source: source.source, sourcePath: source.sourcePath };
}

/** Native API agents omit file provenance; recover it only from an exact verified Markdown body. */
export function buildNativeDiscoveryEntries(
  provider: ServerProvider | undefined,
  files: ReadonlyArray<SourceFile | null>,
): ServerDiscoveryCatalog {
  return {
    agents: (provider?.nativeAgents ?? []).map(
      (agent): ServerDiscoveredAgent => ({
        id: `opencodeV2:native:${agent.id}`,
        provider: "opencodeV2",
        name: agent.name,
        source: "config",
        ...(agent.description ? { description: agent.description } : {}),
        ...verifiedAgentSource(agent, files),
      }),
    ),
    skills: (provider?.skills ?? []).map(
      (skill): ServerDiscoveredSkill => ({
        id: `opencodeV2:native:${skill.path}`,
        provider: "opencodeV2",
        name: skill.name,
        source: "config",
        sourcePath: skill.path,
        ...(skill.description ? { description: skill.description } : {}),
      }),
    ),
  };
}
