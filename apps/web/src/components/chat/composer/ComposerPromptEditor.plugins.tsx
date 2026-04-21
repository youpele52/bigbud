/**
 * ComposerPromptEditor Lexical plugins — all inline Lexical plugin components
 * used inside ComposerPromptEditorInner, plus the shared terminal context actions context.
 *
 * @module ComposerPromptEditor.plugins
 */
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND,
} from "lexical";
import { createContext, useContext, useEffect } from "react";

import { isCollapsedCursorAdjacentToInlineToken } from "../../../logic/composer";
import {
  ComposerTerminalContextNode,
  isComposerInlineTokenNode,
} from "./ComposerPromptEditor.nodes";
import {
  $readSelectionOffsetFromEditorState,
  $setSelectionAtComposerOffset,
  $getComposerRootLength,
  getAbsoluteOffsetForPoint,
} from "./ComposerPromptEditor.nodes.helpers";

// ── Terminal context actions context ──────────────────────────────────

export const ComposerTerminalContextActionsContext = createContext<{
  onRemoveTerminalContext: (contextId: string) => void;
}>({
  onRemoveTerminalContext: () => {},
});

// ── Lexical plugin components ─────────────────────────────────────────

export function ComposerCommandKeyPlugin(props: {
  onCommandKeyDown?: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => boolean;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const handleCommand = (
      key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
      event: KeyboardEvent | null,
    ): boolean => {
      if (!props.onCommandKeyDown || !event) {
        return false;
      }
      const handled = props.onCommandKeyDown(key, event);
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
      return handled;
    };

    const unregisterArrowDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => handleCommand("ArrowDown", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterArrowUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => handleCommand("ArrowUp", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => handleCommand("Enter", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => handleCommand("Tab", event),
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unregisterArrowDown();
      unregisterArrowUp();
      unregisterEnter();
      unregisterTab();
    };
  }, [editor, props]);

  return null;
}

export function ComposerInlineTokenArrowPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const unregisterLeft = editor.registerCommand(
      KEY_ARROW_LEFT_COMMAND,
      (event) => {
        let nextOffset: number | null = null;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
          const currentOffset = $readSelectionOffsetFromEditorState(0);
          if (currentOffset <= 0) return;
          const promptValue = $getRoot().getTextContent();
          if (!isCollapsedCursorAdjacentToInlineToken(promptValue, currentOffset, "left")) {
            return;
          }
          nextOffset = currentOffset - 1;
        });
        if (nextOffset === null) return false;
        const selectionOffset = nextOffset;
        event?.preventDefault();
        event?.stopPropagation();
        editor.update(() => {
          $setSelectionAtComposerOffset(selectionOffset);
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterRight = editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      (event) => {
        let nextOffset: number | null = null;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
          const currentOffset = $readSelectionOffsetFromEditorState(0);
          const composerLength = $getComposerRootLength();
          if (currentOffset >= composerLength) return;
          const promptValue = $getRoot().getTextContent();
          if (!isCollapsedCursorAdjacentToInlineToken(promptValue, currentOffset, "right")) {
            return;
          }
          nextOffset = currentOffset + 1;
        });
        if (nextOffset === null) return false;
        const selectionOffset = nextOffset;
        event?.preventDefault();
        event?.stopPropagation();
        editor.update(() => {
          $setSelectionAtComposerOffset(selectionOffset);
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    return () => {
      unregisterLeft();
      unregisterRight();
    };
  }, [editor]);

  return null;
}

export function ComposerInlineTokenSelectionNormalizePlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      let afterOffset: number | null = null;
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
        const anchorNode = selection.anchor.getNode();
        if (!isComposerInlineTokenNode(anchorNode)) return;
        if (selection.anchor.offset === 0) return;
        const beforeOffset = getAbsoluteOffsetForPoint(anchorNode, 0);
        afterOffset = beforeOffset + 1;
      });
      if (afterOffset !== null) {
        queueMicrotask(() => {
          editor.update(() => {
            $setSelectionAtComposerOffset(afterOffset!);
          });
        });
      }
    });
  }, [editor]);

  return null;
}

export function ComposerInlineTokenBackspacePlugin() {
  const [editor] = useLexicalComposerContext();
  const { onRemoveTerminalContext } = useContext(ComposerTerminalContextActionsContext);

  useEffect(() => {
    return editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }

        const anchorNode = selection.anchor.getNode();
        const selectionOffset = $readSelectionOffsetFromEditorState(0);
        const removeInlineTokenNode = (candidate: unknown): boolean => {
          if (!isComposerInlineTokenNode(candidate)) {
            return false;
          }
          const tokenStart = getAbsoluteOffsetForPoint(candidate, 0);
          candidate.remove();
          if (candidate instanceof ComposerTerminalContextNode) {
            onRemoveTerminalContext(candidate.__context.id);
            $setSelectionAtComposerOffset(selectionOffset);
          } else {
            $setSelectionAtComposerOffset(tokenStart);
          }
          event?.preventDefault();
          return true;
        };
        if (removeInlineTokenNode(anchorNode)) {
          return true;
        }

        if ($isTextNode(anchorNode)) {
          if (selection.anchor.offset > 0) {
            return false;
          }
          if (removeInlineTokenNode(anchorNode.getPreviousSibling())) {
            return true;
          }
          const parent = anchorNode.getParent();
          if ($isElementNode(parent)) {
            const index = anchorNode.getIndexWithinParent();
            if (index > 0 && removeInlineTokenNode(parent.getChildAtIndex(index - 1))) {
              return true;
            }
          }
          return false;
        }

        if ($isElementNode(anchorNode)) {
          const childIndex = selection.anchor.offset - 1;
          if (childIndex >= 0 && removeInlineTokenNode(anchorNode.getChildAtIndex(childIndex))) {
            return true;
          }
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onRemoveTerminalContext]);

  return null;
}
