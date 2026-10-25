import { TERMINAL_AGENTS, type TerminalAgentDescriptor } from "./terminalAgents.ts";
import type { TerminalAgentIdentity } from "@bigbud/contracts/workspace/terminal.agentIdentity.ts";

export interface TerminalTaskTitleEvidence {
  readonly source: "native-title" | "foreground-agent";
  readonly agent: TerminalAgentIdentity;
  readonly title: string;
}

function namesPattern(names: ReadonlyArray<string>): string {
  return names
    .filter((name) => name.trim().length > 0)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
}

function identityPattern(names: ReadonlyArray<string>): RegExp {
  return new RegExp(
    `^(?:${namesPattern(names)})(?:\\s+v?\\d.*|\\s*\\([^)]*\\)|\\s*\\[[^\\]]*\\])?$`,
    "i",
  );
}

function titlePatterns(names: ReadonlyArray<string>) {
  const pattern = `(?:${namesPattern(names)})`;
  return {
    prefix: new RegExp(`^${pattern}\\s*(?:[:|·]| - | — )\\s*`, "i"),
    suffix: new RegExp(`\\s*(?:[|·]| - | — )\\s*${pattern}$`, "i"),
    identity: identityPattern(names),
  };
}

/** Compile declarative adapters once; registering a name is policy, not proof of process execution. */
export function createTerminalAgentEvidenceResolver(
  agents: ReadonlyArray<TerminalAgentDescriptor> = TERMINAL_AGENTS,
) {
  const compiled = new WeakMap<TerminalAgentIdentity, ReturnType<typeof titlePatterns>>();
  const patternsFor = (agent: TerminalAgentIdentity) => {
    let patterns = compiled.get(agent);
    if (!patterns) {
      patterns = titlePatterns(agent.names);
      compiled.set(agent, patterns);
    }
    return patterns;
  };
  const adapters = agents
    .filter((agent) => agent.id.trim() && agent.names.some((name) => name.trim()))
    .map((agent) => ({ agent, patterns: patternsFor(agent) }));
  return {
    resolve(
      raw: string,
      foregroundAgent: TerminalAgentIdentity | null,
    ): TerminalTaskTitleEvidence | null {
      const title = raw.trim().replace(/^[\u2800-\u28ff]\s*/, "");
      for (const adapter of adapters) {
        const marker = adapter.agent.titlePrefixes?.find(
          (prefix) => prefix.length > 0 && title.startsWith(prefix),
        );
        const unmarked = marker ? title.slice(marker.length) : title;
        if (marker || adapter.patterns.prefix.test(title) || adapter.patterns.suffix.test(title)) {
          return {
            source: "native-title",
            agent: adapter.agent,
            title: unmarked
              .replace(adapter.patterns.prefix, "")
              .replace(adapter.patterns.suffix, ""),
          };
        }
      }
      if (!foregroundAgent?.id.trim() || !foregroundAgent.names.some((name) => name.trim()))
        return null;
      const patterns = patternsFor(foregroundAgent);
      return {
        source: "foreground-agent",
        agent: foregroundAgent,
        title: title.replace(patterns.prefix, "").replace(patterns.suffix, ""),
      };
    },
    isIdentity(title: string, evidence: TerminalTaskTitleEvidence): boolean {
      return (
        adapters.some((adapter) => adapter.patterns.identity.test(title)) ||
        patternsFor(evidence.agent).identity.test(title)
      );
    },
  };
}
