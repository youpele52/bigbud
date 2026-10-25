import { PROVIDER_DISPLAY_NAMES } from "@bigbud/contracts/constants/provider.constant.ts";
import type { ProviderKind } from "@bigbud/contracts/orchestration/orchestration.provider.ts";
import type { TerminalAgentIdentity } from "@bigbud/contracts/workspace/terminal.agentIdentity.ts";

/** Shared terminal recognition metadata; terminal-only agents need no native ProviderKind. */
export interface TerminalAgentDescriptor extends TerminalAgentIdentity {
  readonly provider?: ProviderKind;
  readonly executables?: ReadonlyArray<string>;
  readonly scriptPaths?: ReadonlyArray<string>;
  /** Literal, distinctive native title prefixes, including their separating whitespace. */
  readonly titlePrefixes?: ReadonlyArray<string>;
}

function providerAgent(
  provider: ProviderKind,
  metadata: Omit<TerminalAgentDescriptor, "id" | "names" | "provider"> & {
    readonly aliases?: ReadonlyArray<string>;
  },
): TerminalAgentDescriptor {
  const { aliases = [], ...recognition } = metadata;
  return {
    id: provider,
    provider,
    names: [PROVIDER_DISPLAY_NAMES[provider], ...aliases],
    ...recognition,
  };
}

// This is the extension boundary for trusted, shipped terminal adapters. Names are
// literal native labels, not arbitrary user-defined process names or title patterns.
export const TERMINAL_AGENTS: ReadonlyArray<TerminalAgentDescriptor> = [
  // Preserve the detector's existing interpreter-wrapper precedence.
  providerAgent("pi", { executables: ["pi"], scriptPaths: ["/pi-coding-agent/"] }),
  providerAgent("cursor", {
    aliases: ["Cursor Agent"],
    executables: ["cursor-agent", "agent"],
    scriptPaths: ["/cursor-agent/"],
  }),
  providerAgent("claudeAgent", {
    aliases: ["Claude Code"],
    executables: ["claude"],
    scriptPaths: ["/@anthropic-ai/claude-code/"],
    titlePrefixes: ["✳ ", "✻ ", "✽ ", "✶ ", "✢ ", "✦ "],
  }),
  providerAgent("opencode", {
    aliases: ["OC"],
    executables: ["opencode", "opencode2"],
    scriptPaths: ["/@opencode-ai/opencode/"],
  }),
  providerAgent("codex", { executables: ["codex"], scriptPaths: ["/@openai/codex/"] }),
  providerAgent("copilot", { executables: ["copilot"] }),
  providerAgent("devin", { executables: ["devin", "devin-cli"] }),
  providerAgent("kilocode", { aliases: ["Kilo"], executables: ["kilo", "kilocode"] }),
  { id: "gemini", names: ["Gemini", "Gemini CLI"], executables: ["gemini"] },
  { id: "aider", names: ["Aider"], executables: ["aider"] },
  { id: "goose", names: ["Goose"], executables: ["goose"] },
  { id: "amp", names: ["Amp"], executables: ["amp"] },
  { id: "droid", names: ["Droid"], executables: ["droid"] },
  { id: "qwen", names: ["Qwen", "Qwen Code"], executables: ["qwen"] },
  { id: "crush", names: ["Crush"], executables: ["crush"] },
  { id: "deepseek-build", names: ["DeepSeek Build"] },
];

/** Native foreground events already carry detector evidence; display names alone do not create it. */
export function terminalAgentForProvider(
  provider: ProviderKind,
  agents: ReadonlyArray<TerminalAgentDescriptor> = TERMINAL_AGENTS,
): TerminalAgentIdentity {
  const agent = agents.find((candidate) => candidate.provider === provider);
  return agent
    ? { id: agent.id, names: agent.names }
    : {
        id: provider,
        names: [PROVIDER_DISPLAY_NAMES[provider]],
      };
}
