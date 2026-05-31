import { type RefObject } from "react";

import { ComposerCommandMenu, type ComposerCommandItem } from "../../composer/ComposerCommandMenu";
import type { ChatViewComposerDerivedState } from "./chat-view-composer-derived.hooks";
import type { ChatViewInteractionsState } from "./chat-view-interactions.hooks";

interface ChatViewComposerMenuLayerProps {
  syntheticMenuKind: "agent" | "skill" | null;
  syntheticMenuRef: RefObject<HTMLDivElement | null>;
  syntheticMenuItems: ComposerCommandItem[];
  syntheticMenuHighlightId: string | null;
  composer: ChatViewComposerDerivedState;
  interactions: ChatViewInteractionsState;
  resolvedTheme: "light" | "dark";
  disabled: boolean;
  onSyntheticMenuHighlight: (itemId: string | null) => void;
  onSyntheticMenuSelect: (item: ComposerCommandItem) => void;
}

export function ChatViewComposerMenuLayer({
  syntheticMenuKind,
  syntheticMenuRef,
  syntheticMenuItems,
  syntheticMenuHighlightId,
  composer,
  interactions,
  resolvedTheme,
  disabled,
  onSyntheticMenuHighlight,
  onSyntheticMenuSelect,
}: ChatViewComposerMenuLayerProps) {
  if (syntheticMenuKind && !disabled) {
    return (
      <div ref={syntheticMenuRef} className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
        <ComposerCommandMenu
          items={syntheticMenuItems}
          resolvedTheme={resolvedTheme}
          isLoading={false}
          triggerKind={syntheticMenuKind === "skill" ? "skill" : "path"}
          activeItemId={syntheticMenuHighlightId}
          onHighlightedItemChange={onSyntheticMenuHighlight}
          onSelect={onSyntheticMenuSelect}
        />
      </div>
    );
  }

  if (!composer.composerMenuOpen || disabled) {
    return null;
  }

  return (
    <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
      <ComposerCommandMenu
        items={composer.composerMenuItems}
        resolvedTheme={resolvedTheme}
        isLoading={interactions.isComposerMenuLoading}
        triggerKind={composer.composerTriggerKind}
        activeItemId={composer.activeComposerMenuItem?.id ?? null}
        onHighlightedItemChange={interactions.composerCommandHandlers.onComposerMenuItemHighlighted}
        onSelect={interactions.composerCommandHandlers.onSelectComposerItem}
      />
    </div>
  );
}
