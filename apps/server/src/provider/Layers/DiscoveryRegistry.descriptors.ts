import * as OS from "node:os";

import type { ProviderKind, ServerDiscoveredAgent, ServerSettings } from "@bigbud/contracts";
import type { Path } from "effect";

type DiscoverySource = ServerDiscoveredAgent["source"];

export interface DiscoveryFileDescriptor {
  readonly provider: ProviderKind;
  readonly kind: "agent" | "skill";
  readonly source: DiscoverySource;
  readonly path: string;
}

export interface DiscoveryConfigDescriptor {
  readonly provider: "opencode";
  readonly path: string;
}

function expandTildePath(path: Path.Path, input: string): string {
  if (input === "~") {
    return OS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(OS.homedir(), input.slice(2));
  }
  return input;
}

export function buildDiscoveryFileDescriptors(input: {
  readonly path: Path.Path;
  readonly cwd: string;
  readonly settings: Pick<ServerSettings, "providers">;
}): ReadonlyArray<DiscoveryFileDescriptor> {
  const codexHome = input.settings.providers.codex.homePath
    ? expandTildePath(input.path, input.settings.providers.codex.homePath)
    : input.path.join(OS.homedir(), ".codex");

  return [
    {
      provider: "claudeAgent",
      kind: "agent",
      source: "project",
      path: input.path.join(input.cwd, ".claude/agents"),
    },
    {
      provider: "claudeAgent",
      kind: "agent",
      source: "user",
      path: input.path.join(OS.homedir(), ".claude/agents"),
    },
    {
      provider: "claudeAgent",
      kind: "skill",
      source: "project",
      path: input.path.join(input.cwd, ".claude/skills"),
    },
    {
      provider: "claudeAgent",
      kind: "skill",
      source: "user",
      path: input.path.join(OS.homedir(), ".claude/skills"),
    },
    {
      provider: "copilot",
      kind: "agent",
      source: "project",
      path: input.path.join(input.cwd, ".github/agents"),
    },
    {
      provider: "copilot",
      kind: "agent",
      source: "user",
      path: input.path.join(OS.homedir(), ".copilot/agents"),
    },
    {
      provider: "copilot",
      kind: "skill",
      source: "project",
      path: input.path.join(input.cwd, ".github/skills"),
    },
    {
      provider: "copilot",
      kind: "skill",
      source: "project",
      path: input.path.join(input.cwd, ".claude/skills"),
    },
    {
      provider: "copilot",
      kind: "skill",
      source: "project",
      path: input.path.join(input.cwd, ".agents/skills"),
    },
    {
      provider: "copilot",
      kind: "skill",
      source: "user",
      path: input.path.join(OS.homedir(), ".copilot/skills"),
    },
    {
      provider: "copilot",
      kind: "skill",
      source: "user",
      path: input.path.join(OS.homedir(), ".claude/skills"),
    },
    {
      provider: "copilot",
      kind: "skill",
      source: "user",
      path: input.path.join(OS.homedir(), ".agents/skills"),
    },
    {
      provider: "codex",
      kind: "agent",
      source: "project",
      path: input.path.join(input.cwd, ".codex/agents"),
    },
    {
      provider: "codex",
      kind: "agent",
      source: "user",
      path: input.path.join(codexHome, "agents"),
    },
    {
      provider: "codex",
      kind: "skill",
      source: "project",
      path: input.path.join(input.cwd, ".agents/skills"),
    },
    {
      provider: "codex",
      kind: "skill",
      source: "user",
      path: input.path.join(OS.homedir(), ".agents/skills"),
    },
    {
      provider: "codex",
      kind: "skill",
      source: "system",
      path: "/etc/codex/skills",
    },
    {
      provider: "opencode",
      kind: "agent",
      source: "project",
      path: input.path.join(input.cwd, ".opencode/agents"),
    },
    {
      provider: "opencode",
      kind: "agent",
      source: "user",
      path: input.path.join(OS.homedir(), ".config/opencode/agents"),
    },
    {
      provider: "opencode",
      kind: "skill",
      source: "project",
      path: input.path.join(input.cwd, ".opencode/skills"),
    },
    {
      provider: "opencode",
      kind: "skill",
      source: "project",
      path: input.path.join(input.cwd, ".opencode/skill"),
    },
    {
      provider: "opencode",
      kind: "skill",
      source: "project",
      path: input.path.join(input.cwd, ".claude/skills"),
    },
    {
      provider: "opencode",
      kind: "skill",
      source: "project",
      path: input.path.join(input.cwd, ".agents/skills"),
    },
    {
      provider: "opencode",
      kind: "skill",
      source: "user",
      path: input.path.join(OS.homedir(), ".config/opencode/skills"),
    },
    {
      provider: "opencode",
      kind: "skill",
      source: "user",
      path: input.path.join(OS.homedir(), ".config/opencode/skill"),
    },
    {
      provider: "opencode",
      kind: "skill",
      source: "user",
      path: input.path.join(OS.homedir(), ".claude/skills"),
    },
    {
      provider: "opencode",
      kind: "skill",
      source: "user",
      path: input.path.join(OS.homedir(), ".agents/skills"),
    },
    {
      provider: "pi",
      kind: "skill",
      source: "project",
      path: input.path.join(input.cwd, ".pi/skills"),
    },
    {
      provider: "pi",
      kind: "skill",
      source: "project",
      path: input.path.join(input.cwd, ".agents/skills"),
    },
    {
      provider: "pi",
      kind: "skill",
      source: "user",
      path: input.path.join(OS.homedir(), ".pi/agent/skills"),
    },
    {
      provider: "pi",
      kind: "skill",
      source: "user",
      path: input.path.join(OS.homedir(), ".agents/skills"),
    },
  ] satisfies ReadonlyArray<DiscoveryFileDescriptor>;
}

export function buildDiscoveryConfigDescriptors(input: {
  readonly path: Path.Path;
  readonly cwd: string;
}): ReadonlyArray<DiscoveryConfigDescriptor> {
  return [
    { provider: "opencode", path: input.path.join(input.cwd, ".opencode/opencode.json") },
    {
      provider: "opencode",
      path: input.path.join(OS.homedir(), ".config/opencode/opencode.json"),
    },
  ] satisfies ReadonlyArray<DiscoveryConfigDescriptor>;
}
