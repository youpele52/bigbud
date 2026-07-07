import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type ComposerCommandItem } from "../../composer/ComposerCommandMenu";
import { openChatFileTarget } from "../../common/chatFileTargets";
import { buildSkillMentionPrompt } from "~/lib/skillMentions";

import { type ChatViewComposerDerivedState } from "./chat-view-composer-derived.hooks";

interface UseChatViewComposerSyntheticMenuInput {
  readonly composer: ChatViewComposerDerivedState;
  readonly activeProjectCwd: string | null;
  readonly insertMention: (mention: string) => void;
}

export function useChatViewComposerSyntheticMenu(input: UseChatViewComposerSyntheticMenuInput) {
  const [syntheticMenuKind, setSyntheticMenuKind] = useState<"agent" | "skill" | null>(null);
  const [syntheticMenuHighlightId, setSyntheticMenuHighlightId] = useState<string | null>(null);
  const [syntheticMenuSearch, setSyntheticMenuSearch] = useState("");
  const syntheticMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSyntheticMenuSearch("");
  }, [syntheticMenuKind]);

  useEffect(() => {
    if (!syntheticMenuKind) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSyntheticMenuKind(null);
        setSyntheticMenuHighlightId(null);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [syntheticMenuKind]);

  useEffect(() => {
    if (!syntheticMenuKind) return;
    const handler = (event: MouseEvent) => {
      if (syntheticMenuRef.current && !syntheticMenuRef.current.contains(event.target as Node)) {
        setSyntheticMenuKind(null);
        setSyntheticMenuHighlightId(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [syntheticMenuKind]);

  const syntheticAgentItems = useMemo<ComposerCommandItem[]>(() => {
    const query = syntheticMenuSearch.toLowerCase().trim();
    return input.composer.discoveredAgents
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
        type: "agent" as const,
        agent,
        label: `@${agent.name}`,
        description: agent.description ?? "",
      }));
  }, [input.composer.discoveredAgents, syntheticMenuSearch]);

  const syntheticSkillItems = useMemo<ComposerCommandItem[]>(() => {
    const query = syntheticMenuSearch.toLowerCase().trim();
    return input.composer.discoveredSkills
      .filter((skill) => {
        if (!query) return true;
        const skillLabel = skill.displayName ?? skill.name;
        return (
          skill.name.toLowerCase().includes(query) ||
          skillLabel.toLowerCase().includes(query) ||
          skill.provider.toLowerCase().includes(query) ||
          (skill.description?.toLowerCase().includes(query) ?? false)
        );
      })
      .map((skill) => ({
        id: `provider-skill:${skill.provider}:${skill.id}`,
        type: "skill" as const,
        skill,
        label: `$${skill.displayName ?? skill.name}`,
        description: skill.description ?? "",
      }));
  }, [input.composer.discoveredSkills, syntheticMenuSearch]);

  const syntheticMenuItems =
    syntheticMenuKind === "agent"
      ? syntheticAgentItems
      : syntheticMenuKind === "skill"
        ? syntheticSkillItems
        : [];

  const onSyntheticMenuSelect = useCallback(
    (item: ComposerCommandItem) => {
      if (item.type === "agent") {
        input.insertMention(`@agent::${item.agent.name} `);
      } else if (item.type === "skill") {
        input.insertMention(`${buildSkillMentionPrompt(item.skill.name)} `);
      }
      setSyntheticMenuKind(null);
      setSyntheticMenuHighlightId(null);
    },
    [input],
  );

  const onSyntheticMenuHighlight = useCallback((itemId: string | null) => {
    setSyntheticMenuHighlightId(itemId);
  }, []);

  const onSyntheticMenuSearchChange = useCallback((query: string) => {
    setSyntheticMenuSearch(query);
    setSyntheticMenuHighlightId(null);
  }, []);

  const onOpenDiscoveryItemSourcePath = useCallback(
    (item: Extract<ComposerCommandItem, { type: "agent" | "skill" }>) => {
      const sourcePath = item.type === "agent" ? item.agent.sourcePath : item.skill.sourcePath;
      if (!sourcePath) {
        return;
      }
      openChatFileTarget(sourcePath, input.activeProjectCwd ?? undefined);
    },
    [input.activeProjectCwd],
  );

  const onCallAgent = useCallback(() => {
    setSyntheticMenuKind("agent");
    setSyntheticMenuHighlightId(null);
  }, []);

  const onUseSkill = useCallback(() => {
    setSyntheticMenuKind("skill");
    setSyntheticMenuHighlightId(null);
  }, []);

  return {
    onCallAgent,
    onOpenDiscoveryItemSourcePath,
    onSyntheticMenuHighlight,
    onSyntheticMenuSearchChange,
    onSyntheticMenuSelect,
    onUseSkill,
    syntheticMenuHighlightId,
    syntheticMenuItems,
    syntheticMenuKind,
    syntheticMenuRef,
    syntheticMenuSearch,
  };
}
