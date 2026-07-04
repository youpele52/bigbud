import * as OS from "node:os";

import type { Path } from "effect";

import type { DiscoveryFileDescriptor } from "./DiscoveryRegistry.descriptors.ts";

export function expandTildePath(path: Path.Path, input: string): string {
  if (input === "~") {
    return OS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(OS.homedir(), input.slice(2));
  }
  return input;
}

export function bundledSkillsDescriptor(): DiscoveryFileDescriptor | null {
  const bundledSkillsDir = process.env.BIGBUD_BUNDLED_SKILLS_DIR?.trim();
  if (!bundledSkillsDir) {
    return null;
  }

  return {
    provider: "bigbud",
    kind: "skill",
    source: "system",
    path: bundledSkillsDir,
  };
}

export function bundledAgentsDescriptor(): DiscoveryFileDescriptor | null {
  const bundledAgentsDir = process.env.BIGBUD_BUNDLED_AGENTS_DIR?.trim();
  if (!bundledAgentsDir) {
    return null;
  }

  return {
    provider: "opencode",
    kind: "agent",
    source: "system",
    path: bundledAgentsDir,
  };
}
