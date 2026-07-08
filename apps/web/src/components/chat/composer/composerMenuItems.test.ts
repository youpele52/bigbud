import type { ProjectEntry, ServerDiscoveredAgent, ServerDiscoveredSkill } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { buildComposerMenuItems } from "./composerMenuItems";

const agent: ServerDiscoveredAgent = {
  id: "code-consistency",
  provider: "opencode",
  name: "code-consistency",
  source: "user",
  description: "Implements minimal code changes",
};

const codexSkill: ServerDiscoveredSkill = {
  id: "codex-skill",
  provider: "codex",
  name: "review",
  source: "user",
  displayName: "Review",
  description: "Review code changes",
};

const opencodeSkill: ServerDiscoveredSkill = {
  id: "opencode-skill",
  provider: "opencode",
  name: "handoff",
  source: "project",
  description: "Hand off between agents",
};

const workspaceEntry: ProjectEntry = {
  kind: "file",
  path: "src/app.ts",
  parentPath: "src",
};

const baseInput = {
  discoveredAgents: [agent],
  discoveredSkills: [codexSkill, opencodeSkill],
  searchableModelOptions: [
    {
      provider: "codex",
      providerLabel: "Codex",
      slug: "gpt-5.5",
      name: "GPT-5.5",
      subProviderID: undefined,
      searchSlug: "gpt-5.5",
      searchName: "gpt-5.5",
      searchProvider: "codex",
      searchGroup: "",
    },
  ],
  workspaceEntries: [workspaceEntry],
  selectedProvider: "opencode",
  supportsCompact: true,
  activeProviderSlashCommands: [
    {
      name: "doctor",
      description: "Check local setup",
    },
  ],
} as const;

describe("buildComposerMenuItems", () => {
  it("returns agents before workspace paths for @ triggers", () => {
    const items = buildComposerMenuItems({
      ...baseInput,
      composerTrigger: {
        kind: "path",
        query: "",
        rangeStart: 0,
        rangeEnd: 1,
      },
    });

    expect(items.map((item) => item.id)).toEqual([
      "agent:opencode:code-consistency",
      "path:file:src/app.ts",
    ]);
  });

  it("prioritizes skills from the selected provider for skill triggers", () => {
    const items = buildComposerMenuItems({
      ...baseInput,
      composerTrigger: {
        kind: "skill",
        query: "",
        rangeStart: 0,
        rangeEnd: 1,
      },
    });

    expect(items.map((item) => item.id)).toEqual([
      "provider-skill:opencode:opencode-skill",
      "provider-skill:codex:codex-skill",
    ]);
  });

  it("expands slash discovery commands into discovered skills", () => {
    const items = buildComposerMenuItems({
      ...baseInput,
      composerTrigger: {
        kind: "slash-command",
        query: "skills hand",
        rangeStart: 0,
        rangeEnd: "/skills hand".length,
      },
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "skill:opencode:opencode-skill",
      type: "skill",
      label: "handoff",
    });
  });

  it("filters slash commands by query and includes provider commands", () => {
    const items = buildComposerMenuItems({
      ...baseInput,
      composerTrigger: {
        kind: "slash-command",
        query: "do",
        rangeStart: 0,
        rangeEnd: "/do".length,
      },
    });

    expect(items.map((item) => item.id)).toEqual(["provider-slash:opencode:doctor"]);
  });

  it("filters model options for slash-model triggers", () => {
    const items = buildComposerMenuItems({
      ...baseInput,
      composerTrigger: {
        kind: "slash-model",
        query: "5.5",
        rangeStart: 0,
        rangeEnd: "/model 5.5".length,
      },
    });

    expect(items).toEqual([
      {
        id: "model:codex:default:gpt-5.5",
        type: "model",
        provider: "codex",
        model: "gpt-5.5",
        label: "GPT-5.5",
        description: "Codex · gpt-5.5",
      },
    ]);
  });
});
