import { type RefObject } from "react";

import { ComposerCommandMenu, type ComposerCommandItem } from "../../composer/ComposerCommandMenu";
import type { ChatViewComposerDerivedState } from "./chat-view-composer-derived.hooks";
import type { ChatViewInteractionsState } from "./chat-view-interactions.hooks";

interface ChatViewComposerMenuLayerProps {
  syntheticMenuKind: "agent" | "skill" | null;
  syntheticMenuRef: RefObject<HTMLDivElement | null>;
  syntheticMenuItems: ComposerCommandItem[];
  syntheticMenuHighlightId: string | null;
  syntheticMenuSearch: string;
  composer: ChatViewComposerDerivedState;
  interactions: ChatViewInteractionsState;
  resolvedTheme: "light" | "dark";
  disabled: boolean;
  onSyntheticMenuHighlight: (itemId: string | null) => void;
  onSyntheticMenuSelect: (item: ComposerCommandItem) => void;
  onSyntheticMenuSearchChange: (query: string) => void;
  onOpenDiscoveryItemSourcePath: (
    item: Extract<ComposerCommandItem, { type: "agent" | "skill" }>,
  ) => void;
}

export function ChatViewComposerMenuLayer({
  syntheticMenuKind,
  syntheticMenuRef,
  syntheticMenuItems,
  syntheticMenuHighlightId,
  syntheticMenuSearch,
  composer,
  interactions,
  resolvedTheme,
  disabled,
  onSyntheticMenuHighlight,
  onSyntheticMenuSelect,
  onSyntheticMenuSearchChange,
  onOpenDiscoveryItemSourcePath,
}: ChatViewComposerMenuLayerProps) {
  if (syntheticMenuKind && !disabled) {
    const discoverySearch = {
      command: (syntheticMenuKind === "agent" ? "agents" : "skills") as "agents" | "skills",
      query: syntheticMenuSearch,
      onQueryChange: onSyntheticMenuSearchChange,
    };
    return (
      <div ref={syntheticMenuRef} className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
        <ComposerCommandMenu
          items={syntheticMenuItems}
          resolvedTheme={resolvedTheme}
          isLoading={false}
          triggerKind={syntheticMenuKind === "skill" ? "skill" : "path"}
          discoverySearch={discoverySearch}
          activeItemId={syntheticMenuHighlightId}
          onHighlightedItemChange={onSyntheticMenuHighlight}
          onSelect={onSyntheticMenuSelect}
          onOpenItemSourcePath={onOpenDiscoveryItemSourcePath}
        />
      </div>
    );
  }

  if (!composer.composerMenuOpen || disabled) {
    return null;
  }

  const slashDiscoverySearch = composer.slashDiscoverySearch;
  const discoverySearch = slashDiscoverySearch
    ? {
        ...slashDiscoverySearch,
        onQueryChange: (query: string) => {
          interactions.composerCommandHandlers.onChangeComposerDiscoverySearch(
            slashDiscoverySearch.command,
            query,
          );
        },
      }
    : null;

  return (
    <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
      <ComposerCommandMenu
        items={composer.composerMenuItems}
        resolvedTheme={resolvedTheme}
        isLoading={interactions.isComposerMenuLoading}
        triggerKind={composer.composerTriggerKind}
        discoverySearch={discoverySearch}
        activeItemId={composer.activeComposerMenuItem?.id ?? null}
        onHighlightedItemChange={interactions.composerCommandHandlers.onComposerMenuItemHighlighted}
        onSelect={interactions.composerCommandHandlers.onSelectComposerItem}
        onOpenItemSourcePath={onOpenDiscoveryItemSourcePath}
      />
    </div>
  );
}
