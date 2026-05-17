import { useMemo } from "react";

import {
  type ProjectEntry,
  type ProviderKind,
  type ServerDiscoveredAgent,
  type ServerDiscoveredSkill,
} from "@bigbud/contracts";
import { basenameOfPath } from "../../../../lib/vscode-icons";
import { type ComposerCommandItem } from "../../composer/ComposerCommandMenu";

import type { ChatViewBaseState } from "./chat-view-base-state.hooks";

interface ComposerDerivedMenuInput {
  readonly base: ChatViewBaseState;
  readonly discoveredAgents: ReadonlyArray<ServerDiscoveredAgent>;
  readonly discoveredSkills: ReadonlyArray<ServerDiscoveredSkill>;
  readonly searchableModelOptions: ReadonlyArray<{
    provider: ProviderKind;
    providerLabel: string;
    slug: string;
    name: string;
    subProviderID: string | undefined;
    searchSlug: string;
    searchName: string;
    searchProvider: string;
    searchGroup: string;
  }>;
  readonly workspaceEntries: ReadonlyArray<ProjectEntry>;
  readonly selectedProvider: ProviderKind;
  readonly supportsCompact: boolean;
  readonly activeProviderSlashCommands:
    | ReadonlyArray<{
        name: string;
        description?: string | undefined;
        input?: { hint: string } | undefined;
      }>
    | undefined;
}

export function useComposerMenuItems(input: ComposerDerivedMenuInput) {
  return useMemo<ComposerCommandItem[]>(() => {
    const composerTrigger = input.base.composerTrigger;
    if (!composerTrigger) return [];

    if (composerTrigger.kind === "skill") {
      const query = composerTrigger.query.trim().toLowerCase();
      const providerFirstSkills = input.discoveredSkills.filter(
        (skill) => skill.provider === input.selectedProvider,
      );
      const fallbackSkills = input.discoveredSkills.filter(
        (skill) => skill.provider !== input.selectedProvider,
      );
      const rankAndFilter = (skills: ReadonlyArray<ServerDiscoveredSkill>) =>
        skills
          .filter((skill) => {
            if (!query) return true;
            return (
              skill.name.toLowerCase().includes(query) ||
              skill.provider.toLowerCase().includes(query) ||
              (skill.description?.toLowerCase().includes(query) ?? false)
            );
          })
          .map((skill) => ({
            id: `provider-skill:${skill.provider}:${skill.id}`,
            type: "skill",
            skill,
            label: `$${skill.name}`,
            description: `${skill.provider}${skill.description ? ` · ${skill.description}` : ""}`,
          })) satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "skill" }>>;

      return [...rankAndFilter(providerFirstSkills), ...rankAndFilter(fallbackSkills)];
    }

    if (composerTrigger.kind === "path") {
      const query = composerTrigger.query.trim().toLowerCase();
      const agentItems = input.discoveredAgents
        .filter((agent) => {
          if (!query) return true;
          return (
            agent.name.toLowerCase().includes(query) ||
            agent.provider.toLowerCase().includes(query) ||
            (agent.description?.toLowerCase().includes(query) ?? false)
          );
        })
        .map((agent) => ({
          id: `agent:${agent.provider}:${agent.id}`,
          type: "agent",
          agent,
          label: `@${agent.name}`,
          description: `${agent.provider}${agent.description ? ` · ${agent.description}` : ""}`,
        })) satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "agent" }>>;
      const pathItems = input.workspaceEntries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path",
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.parentPath ?? "",
      })) satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "path" }>>;
      return [...agentItems, ...pathItems];
    }

    if (composerTrigger.kind === "slash-command") {
      const providerSlashCommandItems: ReadonlyArray<
        Extract<ComposerCommandItem, { type: "slash-command" }>
      > = (input.activeProviderSlashCommands ?? [])
        .filter((command) => command.name.toLowerCase() !== "compact")
        .map((command) => ({
          id: `provider-slash:${input.selectedProvider}:${command.name}`,
          type: "slash-command",
          command: command.name,
          label: `/${command.name}`,
          description:
            command.description ??
            [input.selectedProvider, command.input?.hint ? `input: ${command.input.hint}` : null]
              .filter(Boolean)
              .join(" · "),
        }));
      const slashCommandItems = [
        {
          id: "slash:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "Switch response model for this thread",
        },
        {
          id: "slash:plan",
          type: "slash-command",
          command: "plan",
          label: "/plan",
          description: "Switch this thread into plan mode",
        },
        {
          id: "slash:default",
          type: "slash-command",
          command: "default",
          label: "/default",
          description: "Switch this thread back to normal build mode",
        },
        {
          id: "slash:agents",
          type: "slash-command",
          command: "agents",
          label: "/agents",
          description: "Browse discovered agents across providers",
        },
        {
          id: "slash:skills",
          type: "slash-command",
          command: "skills",
          label: "/skills",
          description: "Browse discovered skills across providers",
        },
        ...(input.supportsCompact
          ? [
              {
                id: `slash:compact:${input.selectedProvider}`,
                type: "slash-command",
                command: "compact",
                label: "/compact",
                description: `Compact context now using ${input.selectedProvider}`,
              } satisfies Extract<ComposerCommandItem, { type: "slash-command" }>,
            ]
          : []),
        ...providerSlashCommandItems,
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
      const query = composerTrigger.query.trim().toLowerCase();
      const skillItems = input.discoveredSkills
        .filter((skill) => {
          if (!(query === "skills" || query.startsWith("skills "))) {
            return false;
          }
          const skillQuery = query.replace(/^skills\s*/, "");
          if (!skillQuery) return true;
          return (
            skill.name.toLowerCase().includes(skillQuery) ||
            skill.provider.toLowerCase().includes(skillQuery) ||
            (skill.description?.toLowerCase().includes(skillQuery) ?? false)
          );
        })
        .map((skill) => ({
          id: `skill:${skill.provider}:${skill.id}`,
          type: "skill",
          skill,
          label: skill.name,
          description: `${skill.provider}${skill.description ? ` · ${skill.description}` : ""}`,
        })) satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "skill" }>>;
      const agentItems = input.discoveredAgents
        .filter((agent) => {
          if (!(query === "agents" || query.startsWith("agents "))) {
            return false;
          }
          const agentQuery = query.replace(/^agents\s*/, "");
          if (!agentQuery) return true;
          return (
            agent.name.toLowerCase().includes(agentQuery) ||
            agent.provider.toLowerCase().includes(agentQuery) ||
            (agent.description?.toLowerCase().includes(agentQuery) ?? false)
          );
        })
        .map((agent) => ({
          id: `slash-agent:${agent.provider}:${agent.id}`,
          type: "agent",
          agent,
          label: agent.name,
          description: `${agent.provider}${agent.description ? ` · ${agent.description}` : ""}`,
        })) satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "agent" }>>;
      if (!query) {
        return [...slashCommandItems];
      }
      if (query === "agents" || query.startsWith("agents ")) {
        return [...agentItems];
      }
      if (query === "skills" || query.startsWith("skills ")) {
        return [...skillItems];
      }
      return slashCommandItems.filter(
        (item) => item.command.includes(query) || item.label.slice(1).includes(query),
      );
    }

    const query = composerTrigger.query.trim().toLowerCase();
    return input.searchableModelOptions
      .filter(({ searchSlug, searchName, searchProvider, searchGroup }) => {
        if (!query) return true;
        return (
          searchSlug.includes(query) ||
          searchName.includes(query) ||
          searchProvider.includes(query) ||
          searchGroup.includes(query)
        );
      })
      .map(({ provider, providerLabel, slug, name, subProviderID }) => {
        const item: Extract<ComposerCommandItem, { type: "model" }> = {
          id: `model:${provider}:${subProviderID ?? "default"}:${slug}`,
          type: "model",
          provider,
          model: slug,
          label: name,
          description: `${providerLabel} · ${slug}`,
        };
        if (subProviderID !== undefined) {
          item.subProviderID = subProviderID;
        }
        return item;
      });
  }, [
    input.activeProviderSlashCommands,
    input.base.composerTrigger,
    input.discoveredAgents,
    input.discoveredSkills,
    input.searchableModelOptions,
    input.selectedProvider,
    input.supportsCompact,
    input.workspaceEntries,
  ]);
}
