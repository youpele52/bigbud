import { useMemo } from "react";

import { type ProjectEntry } from "@bigbud/contracts";
import {
  buildComposerMenuItems,
  type BuildComposerMenuItemsInput,
} from "../../composer/composerMenuItems";
import { type ComposerCommandItem } from "../../composer/ComposerCommandMenu";

import type { ChatViewBaseState } from "./chat-view-base-state.hooks";

interface ComposerDerivedMenuInput extends Omit<
  BuildComposerMenuItemsInput,
  "composerTrigger" | "workspaceEntries"
> {
  readonly base: ChatViewBaseState;
  readonly workspaceEntries: ReadonlyArray<ProjectEntry>;
}

export function useComposerMenuItems(input: ComposerDerivedMenuInput) {
  return useMemo<ComposerCommandItem[]>(() => {
    return buildComposerMenuItems({
      composerTrigger: input.base.composerTrigger,
      discoveredAgents: input.discoveredAgents,
      discoveredSkills: input.discoveredSkills,
      searchableModelOptions: input.searchableModelOptions,
      workspaceEntries: input.workspaceEntries,
      selectedProvider: input.selectedProvider,
      supportsCompact: input.supportsCompact,
      activeProviderSlashCommands: input.activeProviderSlashCommands,
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
