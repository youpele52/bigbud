import * as OS from "node:os";

import type {
  ServerDiscoveredAgent,
  ServerDiscoveryProviderLabel,
  ServerSettings,
} from "@bigbud/contracts";
import type { Path } from "effect";
import {
  bundledAgentsDescriptor,
  bundledSkillsDescriptor,
  expandTildePath,
} from "./DiscoveryRegistry.descriptors.helpers.ts";

type DiscoverySource = ServerDiscoveredAgent["source"];
type DiscoveryProviderLabel = ServerDiscoveryProviderLabel;

export interface DiscoveryFileDescriptor {
  readonly provider: DiscoveryProviderLabel;
  readonly kind: "agent" | "skill";
  readonly source: DiscoverySource;
  readonly path: string;
}

export interface DiscoveryConfigDescriptor {
  readonly provider: "opencode";
  readonly path: string;
}

export function buildDiscoveryFileDescriptors(input: {
  readonly path: Path.Path;
  readonly cwd: string;
  readonly settings: Pick<ServerSettings, "providers">;
}): ReadonlyArray<DiscoveryFileDescriptor> {
  const codexHome = input.settings.providers.codex.homePath
    ? expandTildePath(input.path, input.settings.providers.codex.homePath)
    : input.path.join(OS.homedir(), ".codex");

  const descriptors = [
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
      provider: "cursor",
      kind: "skill",
      source: "project",
      path: input.path.join(input.cwd, ".cursor/skills"),
    },
    {
      provider: "cursor",
      kind: "skill",
      source: "project",
      path: input.path.join(input.cwd, ".cursor/skills-cursor"),
    },
    {
      provider: "cursor",
      kind: "skill",
      source: "project",
      path: input.path.join(input.cwd, ".agents/skills"),
    },
    {
      provider: "cursor",
      kind: "skill",
      source: "project",
      path: input.path.join(input.cwd, ".claude/skills"),
    },
    {
      provider: "cursor",
      kind: "skill",
      source: "project",
      path: input.path.join(input.cwd, ".codex/skills"),
    },
    {
      provider: "cursor",
      kind: "skill",
      source: "user",
      path: input.path.join(OS.homedir(), ".cursor/skills"),
    },
    {
      provider: "cursor",
      kind: "skill",
      source: "user",
      path: input.path.join(OS.homedir(), ".cursor/skills-cursor"),
    },
    {
      provider: "cursor",
      kind: "skill",
      source: "user",
      path: input.path.join(OS.homedir(), ".agents/skills"),
    },
    {
      provider: "cursor",
      kind: "skill",
      source: "user",
      path: input.path.join(OS.homedir(), ".claude/skills"),
    },
    {
      provider: "cursor",
      kind: "skill",
      source: "user",
      path: input.path.join(OS.homedir(), ".codex/skills"),
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
      provider: "kilocode",
      kind: "agent",
      source: "project",
      path: input.path.join(input.cwd, ".kilocode/agents"),
    },
    {
      provider: "kilocode",
      kind: "agent",
      source: "user",
      path: input.path.join(OS.homedir(), ".config/kilocode/agents"),
    },
    {
      provider: "kilocode",
      kind: "skill",
      source: "project",
      path: input.path.join(input.cwd, ".kilocode/skills"),
    },
    {
      provider: "kilocode",
      kind: "skill",
      source: "project",
      path: input.path.join(input.cwd, ".agents/skills"),
    },
    {
      provider: "kilocode",
      kind: "skill",
      source: "user",
      path: input.path.join(OS.homedir(), ".config/kilocode/skills"),
    },
    {
      provider: "kilocode",
      kind: "skill",
      source: "user",
      path: input.path.join(OS.homedir(), ".agents/skills"),
    },
    {
      provider: "devin",
      kind: "agent",
      source: "project",
      path: input.path.join(input.cwd, ".devin/agents"),
    },
    {
      provider: "devin",
      kind: "agent",
      source: "user",
      path: input.path.join(OS.homedir(), ".config/devin/agents"),
    },
    {
      provider: "devin",
      kind: "skill",
      source: "project",
      path: input.path.join(input.cwd, ".devin/skills"),
    },
    {
      provider: "devin",
      kind: "skill",
      source: "project",
      path: input.path.join(input.cwd, ".agents/skills"),
    },
    {
      provider: "devin",
      kind: "skill",
      source: "user",
      path: input.path.join(OS.homedir(), ".config/devin/skills"),
    },
    {
      provider: "devin",
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
    {
      provider: "bigbud",
      kind: "skill",
      source: "project",
      path: input.path.join(input.cwd, ".bigbud/skills"),
    },
    {
      provider: "bigbud",
      kind: "skill",
      source: "user",
      path: input.path.join(OS.homedir(), ".bigbud/skills"),
    },
  ] satisfies ReadonlyArray<DiscoveryFileDescriptor>;

  const bundled = [bundledSkillsDescriptor(), bundledAgentsDescriptor()].filter(
    (descriptor): descriptor is DiscoveryFileDescriptor => descriptor !== null,
  );
  return bundled.length > 0 ? [...descriptors, ...bundled] : descriptors;
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
