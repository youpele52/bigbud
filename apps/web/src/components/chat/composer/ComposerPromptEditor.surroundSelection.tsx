import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, $getSelection, $isRangeSelection } from "lexical";
import { useCallback, useEffect, useRef } from "react";
import {
  collapseExpandedComposerCursor,
  selectionTouchesMentionBoundary,
} from "../../../logic/composer";
import { type TerminalContextDraft } from "../../../lib/terminalContext";
import {
  $selectionTouchesInlineToken,
  $setComposerEditorPrompt,
  $setSelectionRangeAtComposerOffsets,
  getSelectionRangeForExpandedComposerOffsets,
} from "./ComposerPromptEditor.nodes.helpers";

const SURROUND_SYMBOLS: ReadonlyArray<readonly [string, string]> = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["'", "'"],
  ['"', '"'],
  ["`", "`"],
  ["*", "*"],
  ["_", "_"],
  ["<", ">"],
];

const SURROUND_SYMBOLS_MAP = new Map<string, string>(SURROUND_SYMBOLS);

interface SelectionSnapshot {
  value: string;
  expandedStart: number;
  expandedEnd: number;
}

interface ComposerSurroundSelectionPluginProps {
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
}

function readSelectionSnapshot(): SelectionSnapshot | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || selection.isCollapsed()) {
    return null;
  }

  if ($selectionTouchesInlineToken(selection)) {
    return null;
  }

  const range = getSelectionRangeForExpandedComposerOffsets(selection);
  if (!range || range.start === range.end) {
    return null;
  }

  const value = $getRoot().getTextContent();
  if (selectionTouchesMentionBoundary(value, range.start, range.end)) {
    return null;
  }

  return {
    value,
    expandedStart: range.start,
    expandedEnd: range.end,
  };
}

export function ComposerSurroundSelectionPlugin({
  terminalContexts,
}: ComposerSurroundSelectionPluginProps) {
  const [editor] = useLexicalComposerContext();
  const terminalContextsRef = useRef(terminalContexts);
  const pendingSelectionRef = useRef<SelectionSnapshot | null>(null);

  useEffect(() => {
    terminalContextsRef.current = terminalContexts;
  }, [terminalContexts]);

  const applySurroundInsertion = useCallback(
    (inputData: string): boolean => {
      const surroundCloseSymbol = SURROUND_SYMBOLS_MAP.get(inputData);
      const pendingSelection = pendingSelectionRef.current;
      if (!surroundCloseSymbol || !pendingSelection) {
        pendingSelectionRef.current = null;
        return false;
      }

      let handled = false;
      editor.update(() => {
        const currentValue = $getRoot().getTextContent();
        const selectionSnapshot =
          currentValue === pendingSelection.value ? pendingSelection : readSelectionSnapshot();
        if (!selectionSnapshot) {
          pendingSelectionRef.current = null;
          return;
        }

        const selectedText = selectionSnapshot.value.slice(
          selectionSnapshot.expandedStart,
          selectionSnapshot.expandedEnd,
        );
        const nextValue = `${selectionSnapshot.value.slice(0, selectionSnapshot.expandedStart)}${inputData}${selectedText}${surroundCloseSymbol}${selectionSnapshot.value.slice(selectionSnapshot.expandedEnd)}`;
        $setComposerEditorPrompt(nextValue, terminalContextsRef.current);
        const selectionStart = collapseExpandedComposerCursor(
          nextValue,
          selectionSnapshot.expandedStart,
        );
        $setSelectionRangeAtComposerOffsets(
          selectionStart + inputData.length,
          selectionStart + inputData.length + selectedText.length,
        );
        handled = true;
        pendingSelectionRef.current = null;
      });

      return handled;
    },
    [editor],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) {
        pendingSelectionRef.current = null;
        return;
      }

      editor.getEditorState().read(() => {
        pendingSelectionRef.current = readSelectionSnapshot();
      });
    };

    const onBeforeInput = (event: InputEvent) => {
      if (
        event.inputType !== "insertText" ||
        typeof event.data !== "string" ||
        event.data.length !== 1
      ) {
        pendingSelectionRef.current = null;
        return;
      }

      if (!applySurroundInsertion(event.data)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    let activeRootElement: HTMLElement | null = null;
    const unregisterRootListener = editor.registerRootListener((rootElement, prevRootElement) => {
      prevRootElement?.removeEventListener("keydown", onKeyDown);
      prevRootElement?.removeEventListener("beforeinput", onBeforeInput, true);
      rootElement?.addEventListener("keydown", onKeyDown);
      rootElement?.addEventListener("beforeinput", onBeforeInput, true);
      activeRootElement = rootElement;
    });

    return () => {
      activeRootElement?.removeEventListener("keydown", onKeyDown);
      activeRootElement?.removeEventListener("beforeinput", onBeforeInput, true);
      unregisterRootListener();
    };
  }, [applySurroundInsertion, editor]);

  return null;
}
