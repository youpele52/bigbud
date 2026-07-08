import {
  type ExecutionTargetId,
  type ModelSelection,
  type ServerDiscoveredAgent,
  type ServerDiscoveredSkill,
  type ServerProvider,
} from "@bigbud/contracts";
import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useEffect, useMemo, useRef, useState } from "react";

import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import { getProviderModels } from "~/models/provider";

import { buildSkillMentionPrompt } from "../../../lib/skillMentions";
import {
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  replaceTextRange,
  type ComposerTrigger,
} from "../../../logic/composer";
import { type ComposerPromptEditorHandle } from "../composer/ComposerPromptEditor";
import { buildComposerMenuItems } from "../composer/composerMenuItems";
import { type ComposerCommandItem } from "../composer/ComposerCommandMenu";
import { type ComposerMicButtonHandle } from "../composer/ComposerMicButton";
import { getComposerProviderState } from "../provider/composerProviderRegistry";
import { COMPOSER_PATH_QUERY_DEBOUNCE_MS } from "../view/ChatView.constants.logic";
import { modelPickerValue } from "../view/ChatView.modelSelection.logic";
import { EMPTY_PROJECT_ENTRIES } from "../view/chat-view/shared";
import {
  buildSearchableModelOptions,
  createOrchestraModelSelection,
  extendReplacementRangeForTrailingSpace,
  filterUnsupportedSlashCommands,
  resolveDiscoverySearch,
} from "./OrchestraPlayerComposer.menu";
import { type ModelOptionsByProvider } from "./OrchestraPlayerComposer.types";

export function useOrchestraPlayerComposer(input: {
  assignment: {
    modelSelection: ModelSelection;
    prompt: string;
  };
  providers: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: ModelOptionsByProvider;
  discoveredAgents: ReadonlyArray<ServerDiscoveredAgent>;
  discoveredSkills: ReadonlyArray<ServerDiscoveredSkill>;
  activeProjectCwd: string | null;
  workspaceExecutionTargetId?: ExecutionTargetId | null | undefined;
  onChange: (update: Partial<{ prompt: string; modelSelection: ModelSelection }>) => void;
}) {
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const micRef = useRef<ComposerMicButtonHandle>(null);
  const promptRef = useRef(input.assignment.prompt);
  const [cursor, setCursor] = useState(() =>
    collapseExpandedComposerCursor(input.assignment.prompt, input.assignment.prompt.length),
  );
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(input.assignment.prompt, input.assignment.prompt.length),
  );
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [syntheticMenuKind, setSyntheticMenuKind] = useState<"agent" | "skill" | null>(null);
  const [syntheticMenuSearch, setSyntheticMenuSearch] = useState("");

  useEffect(() => {
    promptRef.current = input.assignment.prompt;
  }, [input.assignment.prompt]);

  useEffect(() => {
    if (!syntheticMenuKind) {
      setSyntheticMenuSearch("");
      setHighlightedItemId(null);
    }
  }, [syntheticMenuKind]);

  const selectedProvider = input.assignment.modelSelection.provider;
  const providerModels = useMemo(
    () => getProviderModels(input.providers, selectedProvider),
    [input.providers, selectedProvider],
  );
  const providerState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: input.assignment.modelSelection.model,
        models: providerModels,
        prompt: input.assignment.prompt,
        modelOptions: {
          [selectedProvider]: undefined,
        },
      }),
    [
      input.assignment.modelSelection.model,
      input.assignment.prompt,
      providerModels,
      selectedProvider,
    ],
  );
  const activeProviderSlashCommands = useMemo(
    () => input.providers.find((provider) => provider.provider === selectedProvider)?.slashCommands,
    [input.providers, selectedProvider],
  );
  const searchableModelOptions = useMemo(
    () => buildSearchableModelOptions(input.modelOptionsByProvider),
    [input.modelOptionsByProvider],
  );

  const isPathTrigger = trigger?.kind === "path";
  const pathTriggerQuery = trigger?.kind === "path" ? trigger.query : "";
  const [debouncedPathQuery, pathQueryDebouncer] = useDebouncedValue(pathTriggerQuery, {
    wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS,
  });
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: input.activeProjectCwd,
      executionTargetId: input.workspaceExecutionTargetId,
      query: pathTriggerQuery.length > 0 ? debouncedPathQuery : "",
      enabled: isPathTrigger,
      limit: 80,
    }),
  );
  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;

  function setPromptValue(nextPrompt: string, nextCursor: number, nextExpandedCursor: number) {
    promptRef.current = nextPrompt;
    input.onChange({ prompt: nextPrompt });
    setCursor(nextCursor);
    setTrigger(detectComposerTrigger(nextPrompt, nextExpandedCursor));
  }

  function applyPromptReplacement(
    rangeStart: number,
    rangeEnd: number,
    replacement: string,
  ): boolean {
    const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
    const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
    setPromptValue(next.text, nextCursor, next.cursor);
    window.requestAnimationFrame(() => {
      editorRef.current?.focusAt(nextCursor);
    });
    return true;
  }

  function insertMention(mention: string) {
    const snapshot = editorRef.current?.readSnapshot();
    const value = snapshot?.value ?? promptRef.current;
    const expandedCursor = snapshot?.expandedCursor ?? expandCollapsedComposerCursor(value, cursor);
    const prefix = expandedCursor > 0 && !/\s/.test(value[expandedCursor - 1] ?? "") ? " " : "";
    const insertion = prefix + mention;
    const nextValue = value.slice(0, expandedCursor) + insertion + value.slice(expandedCursor);
    const nextExpandedCursor = expandedCursor + insertion.length;
    const nextCursor = collapseExpandedComposerCursor(nextValue, nextExpandedCursor);
    setPromptValue(nextValue, nextCursor, nextExpandedCursor);
  }

  const triggerMenuItems = useMemo(
    () =>
      filterUnsupportedSlashCommands(
        buildComposerMenuItems({
          composerTrigger: trigger,
          discoveredAgents: input.discoveredAgents,
          discoveredSkills: input.discoveredSkills,
          searchableModelOptions,
          workspaceEntries,
          selectedProvider,
          supportsCompact: false,
          activeProviderSlashCommands,
        }),
      ),
    [
      activeProviderSlashCommands,
      input.discoveredAgents,
      input.discoveredSkills,
      searchableModelOptions,
      selectedProvider,
      trigger,
      workspaceEntries,
    ],
  );

  const syntheticMenuItems = useMemo(() => {
    const query = syntheticMenuSearch.trim().toLowerCase();
    if (syntheticMenuKind === "agent") {
      return input.discoveredAgents
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
    }
    if (syntheticMenuKind === "skill") {
      return input.discoveredSkills
        .filter((skill) => {
          if (!query) return true;
          return (
            skill.name.toLowerCase().includes(query) ||
            (skill.displayName ?? skill.name).toLowerCase().includes(query) ||
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
    }
    return [];
  }, [input.discoveredAgents, input.discoveredSkills, syntheticMenuKind, syntheticMenuSearch]);

  const composerMenuItems = syntheticMenuKind ? syntheticMenuItems : triggerMenuItems;
  const activeComposerMenuItem =
    composerMenuItems.find((item) => item.id === highlightedItemId) ?? composerMenuItems[0] ?? null;

  const discoverySearch = syntheticMenuKind
    ? {
        command: syntheticMenuKind === "agent" ? ("agents" as const) : ("skills" as const),
        query: syntheticMenuSearch,
        onQueryChange: (query: string) => {
          setSyntheticMenuSearch(query);
          setHighlightedItemId(null);
        },
      }
    : resolveDiscoverySearch({
        syntheticMenuKind,
        syntheticMenuSearch,
        trigger,
        applyPromptReplacement,
        onResetHighlight: () => setHighlightedItemId(null),
      });

  const isComposerMenuLoading =
    isPathTrigger &&
    ((pathTriggerQuery.length > 0 && pathQueryDebouncer.state.isPending) ||
      workspaceEntriesQuery.isLoading ||
      workspaceEntriesQuery.isFetching);

  function onSelectComposerItem(item: ComposerCommandItem) {
    if (syntheticMenuKind) {
      if (item.type === "agent") {
        insertMention(`@agent::${item.agent.name} `);
      } else if (item.type === "skill") {
        insertMention(`${buildSkillMentionPrompt(item.skill.name)} `);
      }
      setSyntheticMenuKind(null);
      setHighlightedItemId(null);
      return;
    }

    if (!trigger) return;
    if (item.type === "path" || item.type === "agent" || item.type === "skill") {
      const replacement =
        item.type === "path"
          ? `@${item.path} `
          : item.type === "agent"
            ? `@agent::${item.agent.name} `
            : `${buildSkillMentionPrompt(item.skill.name)} `;
      const rangeEnd = extendReplacementRangeForTrailingSpace(
        promptRef.current,
        trigger.rangeEnd,
        replacement,
      );
      applyPromptReplacement(trigger.rangeStart, rangeEnd, replacement);
      setHighlightedItemId(null);
      return;
    }
    if (item.type === "slash-command") {
      const replacement = `/${item.command} `;
      const rangeEnd = extendReplacementRangeForTrailingSpace(
        promptRef.current,
        trigger.rangeEnd,
        replacement,
      );
      applyPromptReplacement(trigger.rangeStart, rangeEnd, replacement);
      setHighlightedItemId(null);
      return;
    }

    input.onChange({
      modelSelection: createOrchestraModelSelection({
        provider: item.provider,
        model: item.model,
        ...(item.subProviderID ? { subProviderID: item.subProviderID } : {}),
        providers: input.providers,
        prompt: input.assignment.prompt,
      }),
    });
    applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "");
    setHighlightedItemId(null);
  }

  return {
    editorRef,
    micRef,
    cursor,
    trigger,
    highlightedItemId,
    isRecording,
    syntheticMenuKind,
    selectedProvider,
    providerState,
    providerModelValue: modelPickerValue(input.assignment.modelSelection),
    composerMenuItems,
    activeComposerMenuItem,
    discoverySearch,
    isComposerMenuLoading,
    setHighlightedItemId,
    setIsRecording,
    setSyntheticMenuKind,
    setPromptValue,
    onSelectComposerItem,
    onPromptChange: (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
    ) => {
      promptRef.current = nextPrompt;
      input.onChange({ prompt: nextPrompt });
      setCursor(nextCursor);
      setTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
    },
    onCommandKeyDown: (
      key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Backspace" | "Escape",
      event: KeyboardEvent,
    ) => {
      const menuOpen = syntheticMenuKind !== null || trigger !== null;
      if (!menuOpen) return false;
      if (key === "ArrowDown" && composerMenuItems.length > 0) {
        event.preventDefault();
        const currentIndex = composerMenuItems.findIndex((item) => item.id === highlightedItemId);
        const nextItem =
          composerMenuItems[
            ((currentIndex >= 0 ? currentIndex : -1) + 1) % composerMenuItems.length
          ];
        setHighlightedItemId(nextItem?.id ?? null);
        return true;
      }
      if (key === "ArrowUp" && composerMenuItems.length > 0) {
        event.preventDefault();
        const currentIndex = composerMenuItems.findIndex((item) => item.id === highlightedItemId);
        const startIndex = currentIndex >= 0 ? currentIndex : composerMenuItems.length;
        const nextItem =
          composerMenuItems[(startIndex - 1 + composerMenuItems.length) % composerMenuItems.length];
        setHighlightedItemId(nextItem?.id ?? null);
        return true;
      }
      if ((key === "Enter" || key === "Tab") && activeComposerMenuItem) {
        event.preventDefault();
        onSelectComposerItem(activeComposerMenuItem);
        return true;
      }
      if (key === "Escape") {
        event.preventDefault();
        setSyntheticMenuKind(null);
        setHighlightedItemId(null);
        return true;
      }
      return false;
    },
  };
}
