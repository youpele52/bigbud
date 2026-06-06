import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { gitStatusQueryOptions } from "~/lib/gitReactQuery";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";

import { projectScriptCwd } from "@bigbud/shared/projectScripts";
import {
  useServerAvailableEditors,
  useServerConfig,
  useServerDiscoveredAgents,
  useServerDiscoveredSkills,
  useServerKeybindings,
} from "~/rpc/serverState";
import { shortcutLabelForCommand } from "../../../../models/keybindings";
import { resolveWorkspaceExecutionTargetId } from "../../../../lib/providerExecutionTargets";
import { COMPOSER_PATH_QUERY_DEBOUNCE_MS } from "../ChatView.constants.logic";

import {
  EMPTY_DISCOVERED_AGENTS,
  EMPTY_DISCOVERED_SKILLS,
  EMPTY_PROJECT_ENTRIES,
  EMPTY_PROVIDERS,
} from "./shared";
import { type ChatViewBaseState } from "./chat-view-base-state.hooks";
import { useComposerMenuItems } from "./chat-view-composer-derived.menu";
import { useComposerProviderState } from "./chat-view-composer-derived.models";

function resolveSlashDiscoverySearch(
  query: string | undefined,
): { command: "agents" | "skills"; query: string } | null {
  if (!query) return null;
  const normalizedQuery = query.trim().toLowerCase();
  if (
    normalizedQuery === "agents" ||
    "agents".startsWith(normalizedQuery) ||
    normalizedQuery.startsWith("agents ")
  ) {
    return {
      command: "agents",
      query:
        normalizedQuery === "agents" || "agents".startsWith(normalizedQuery)
          ? ""
          : query.slice("agents".length + 1),
    };
  }
  if (
    normalizedQuery === "skills" ||
    "skills".startsWith(normalizedQuery) ||
    normalizedQuery.startsWith("skills ") ||
    normalizedQuery === "skill" ||
    "skills".startsWith(normalizedQuery) ||
    normalizedQuery.startsWith("skill ")
  ) {
    const baseCommand = normalizedQuery.startsWith("skill") ? "skill" : "skills";
    return {
      command: "skills",
      query:
        normalizedQuery === baseCommand || "skills".startsWith(normalizedQuery)
          ? ""
          : query.slice(baseCommand.length + 1),
    };
  }
  return null;
}

export function useChatViewComposerDerivedState(base: ChatViewBaseState) {
  const serverConfig = useServerConfig();
  const providerStatuses = serverConfig?.providers ?? EMPTY_PROVIDERS;
  const {
    sessionProvider,
    selectedProviderByThreadId,
    threadProvider,
    hasThreadStarted,
    lockedProvider,
    selectedProvider,
    composerModelOptions,
    selectedModel,
    selectedProviderModels,
    selectedDraftOrThreadModelSelection,
    composerProviderState,
    selectedPromptEffort,
    selectedModelOptionsForDispatch,
    selectedModelSelection,
    selectedModelForPicker,
    modelOptionsByProvider,
    activeProviderStatus,
    selectedModelForPickerWithCustomFallback,
    searchableModelOptions,
    supportsCompact,
  } = useComposerProviderState(base, providerStatuses);
  const gitCwd = base.activeProject
    ? projectScriptCwd({
        project: { cwd: base.activeProject.cwd },
        worktreePath: base.activeThread?.worktreePath ?? null,
      })
    : null;
  const composerTriggerKind = base.composerTrigger?.kind ?? null;
  const pathTriggerQuery = base.composerTrigger?.kind === "path" ? base.composerTrigger.query : "";
  const isPathTrigger = composerTriggerKind === "path";
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    pathTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectivePathQuery = pathTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const gitStatusQuery = useQuery(
    gitStatusQueryOptions(
      gitCwd,
      base.activeProject ? resolveWorkspaceExecutionTargetId(base.activeProject) : undefined,
    ),
  );
  const keybindings = useServerKeybindings();
  const availableEditors = useServerAvailableEditors();
  const discoveredAgents = useServerDiscoveredAgents() ?? EMPTY_DISCOVERED_AGENTS;
  const discoveredSkills = useServerDiscoveredSkills() ?? EMPTY_DISCOVERED_SKILLS;

  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: gitCwd,
      executionTargetId: base.activeProject
        ? resolveWorkspaceExecutionTargetId(base.activeProject)
        : undefined,
      query: effectivePathQuery,
      enabled: isPathTrigger,
      limit: 80,
    }),
  );
  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;

  const composerMenuItems = useComposerMenuItems({
    base,
    discoveredAgents,
    discoveredSkills,
    searchableModelOptions,
    workspaceEntries,
    selectedProvider,
    supportsCompact,
    activeProviderSlashCommands: activeProviderStatus?.slashCommands,
  });

  const composerMenuOpen = Boolean(base.composerTrigger);
  const slashDiscoverySearch =
    base.composerTrigger?.kind === "slash-command"
      ? resolveSlashDiscoverySearch(base.composerTrigger.query)
      : null;
  const activeComposerMenuItem = useMemo(
    () =>
      composerMenuItems.find((item) => item.id === base.composerHighlightedItemId) ??
      composerMenuItems[0] ??
      null,
    [base.composerHighlightedItemId, composerMenuItems],
  );

  base.composerMenuOpenRef.current = composerMenuOpen;
  base.composerMenuItemsRef.current = composerMenuItems;
  base.activeComposerMenuItemRef.current = activeComposerMenuItem;

  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(base.nonPersistedComposerImageIds),
    [base.nonPersistedComposerImageIds],
  );
  const isGitRepo = gitCwd !== null && gitStatusQuery.data?.isRepo === true;
  const terminalShortcutLabelOptions = useMemo(
    () => ({
      context: { terminalFocus: true, terminalOpen: Boolean(base.terminalState.terminalOpen) },
    }),
    [base.terminalState.terminalOpen],
  );
  const nonTerminalShortcutLabelOptions = useMemo(
    () => ({
      context: { terminalFocus: false, terminalOpen: Boolean(base.terminalState.terminalOpen) },
    }),
    [base.terminalState.terminalOpen],
  );
  const terminalToggleShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.toggle"),
    [keybindings],
  );
  const terminalPanelToggleShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminalPanel.toggle"),
    [keybindings],
  );
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const diffPanelShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "diff.toggle", nonTerminalShortcutLabelOptions),
    [keybindings, nonTerminalShortcutLabelOptions],
  );
  const browserPanelShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "browser.toggle", nonTerminalShortcutLabelOptions),
    [keybindings, nonTerminalShortcutLabelOptions],
  );
  const filesPanelShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "files.toggle", nonTerminalShortcutLabelOptions),
    [keybindings, nonTerminalShortcutLabelOptions],
  );
  const sidebarToggleShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "sidebar.toggle"),
    [keybindings],
  );
  const rightPanelToggleShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "rightPanel.toggle"),
    [keybindings],
  );
  const searchToggleShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "search.toggle"),
    [keybindings],
  );

  return {
    sessionProvider,
    selectedProviderByThreadId,
    threadProvider,
    hasThreadStarted,
    lockedProvider,
    providerStatuses,
    selectedProvider,
    composerModelOptions,
    selectedModel,
    selectedProviderModels,
    selectedDraftOrThreadModelSelection,
    composerProviderState,
    selectedPromptEffort,
    selectedModelOptionsForDispatch,
    selectedModelSelection,
    selectedModelForPicker,
    gitCwd,
    composerTriggerKind,
    pathTriggerQuery,
    composerPathQueryDebouncer,
    effectivePathQuery,
    gitStatusQuery,
    keybindings,
    availableEditors,
    discoveredAgents,
    discoveredSkills,
    modelOptionsByProvider,
    selectedModelForPickerWithCustomFallback,
    workspaceEntriesQuery,
    workspaceEntries,
    composerMenuItems,
    composerMenuOpen,
    slashDiscoverySearch,
    activeComposerMenuItem,
    nonPersistedComposerImageIdSet,
    activeProviderStatus,
    isGitRepo,
    terminalToggleShortcutLabel,
    terminalPanelToggleShortcutLabel,
    splitTerminalShortcutLabel,
    newTerminalShortcutLabel,
    closeTerminalShortcutLabel,
    diffPanelShortcutLabel,
    browserPanelShortcutLabel,
    filesPanelShortcutLabel,
    sidebarToggleShortcutLabel,
    rightPanelToggleShortcutLabel,
    searchToggleShortcutLabel,
  };
}

export type ChatViewComposerDerivedState = ReturnType<typeof useChatViewComposerDerivedState>;
