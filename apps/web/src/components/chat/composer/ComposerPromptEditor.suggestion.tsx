/**
 * Prompt suggestion ghost text (Phase 7). Shown only while the composer is empty (it is the
 * editor placeholder). Tab or → accepts it into the composer; typing hides it; Enter never sends
 * it, because an unaccepted suggestion is never part of the prompt. A tap chip accepts it on
 * touch devices.
 *
 * @module ComposerPromptEditor.suggestion
 */
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import type { ServerDiscoveredSkill } from "@bigbud/contracts";
import {
  $getRoot,
  COMMAND_PRIORITY_CRITICAL,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalEditor,
} from "lexical";
import { useEffect } from "react";

import { $setComposerEditorPrompt } from "./ComposerPromptEditor.nodes.helpers";

export function promptSuggestionAriaLabel(suggestion: string): string {
  return `Suggested follow-up: ${suggestion}. Press Tab to use it.`;
}

/** Replaces an empty composer with the suggestion and puts the cursor at its end. */
export function acceptPromptSuggestion(
  editor: LexicalEditor,
  suggestion: string,
  discoveredSkills: ReadonlyArray<ServerDiscoveredSkill>,
): boolean {
  const empty = editor.getEditorState().read(() => $getRoot().getTextContent().length === 0);
  if (!empty) return false;
  editor.update(() => {
    $setComposerEditorPrompt(suggestion, [], discoveredSkills);
    $getRoot().selectEnd();
  });
  editor.focus();
  return true;
}

export function ComposerPromptSuggestionPlugin(props: {
  suggestion: string | null | undefined;
  discoveredSkills: ReadonlyArray<ServerDiscoveredSkill>;
}) {
  const [editor] = useLexicalComposerContext();
  const { suggestion, discoveredSkills } = props;
  useEffect(() => {
    if (!suggestion) return;
    const accept = (event: KeyboardEvent | null) => {
      if (!event || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
      if (!acceptPromptSuggestion(editor, suggestion, discoveredSkills)) return false;
      event.preventDefault();
      return true;
    };
    const removeTab = editor.registerCommand(KEY_TAB_COMMAND, accept, COMMAND_PRIORITY_CRITICAL);
    const removeArrow = editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      accept,
      COMMAND_PRIORITY_CRITICAL,
    );
    return () => {
      removeTab();
      removeArrow();
    };
  }, [editor, suggestion, discoveredSkills]);
  return null;
}

/** The ghost text placeholder, with a Tab hint (pointer devices) or a tap chip (touch). */
export function ComposerPromptSuggestionGhost(props: {
  suggestion: string;
  discoveredSkills: ReadonlyArray<ServerDiscoveredSkill>;
}) {
  const [editor] = useLexicalComposerContext();
  return (
    <div
      className="pointer-events-none absolute inset-0 text-inherit leading-[inherit]"
      data-prompt-suggestion
    >
      <span className="text-muted-foreground/60">{props.suggestion}</span>{" "}
      <kbd className="rounded border border-border/70 px-1 text-xs text-muted-foreground/70 pointer-coarse:hidden">
        Tab
      </kbd>
      <button
        type="button"
        className="pointer-events-auto ml-1 hidden rounded-full border border-border px-2 text-xs text-muted-foreground pointer-coarse:inline-flex"
        aria-label={`Use suggested follow-up: ${props.suggestion}`}
        onClick={() => acceptPromptSuggestion(editor, props.suggestion, props.discoveredSkills)}
      >
        Use
      </button>
    </div>
  );
}
