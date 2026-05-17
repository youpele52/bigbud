import { type ServerDiscoveredSkill } from "@bigbud/contracts";
import { type ClipboardEventHandler } from "react";

import { type TerminalContextDraft } from "~/lib/terminalContext";

export interface ComposerPromptEditorHandle {
  focus: () => void;
  focusAt: (cursor: number) => void;
  focusAtEnd: () => void;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  };
}

export interface ComposerPromptEditorProps {
  value: string;
  cursor: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  discoveredSkills?: ReadonlyArray<ServerDiscoveredSkill> | undefined;
  disabled: boolean;
  placeholder: string;
  className?: string;
  onRemoveTerminalContext: (contextId: string) => void;
  onChange: (
    nextValue: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
    terminalContextIds: string[],
  ) => void;
  onCommandKeyDown?: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Backspace" | "Escape",
    event: KeyboardEvent,
  ) => boolean;
  onPaste: ClipboardEventHandler<HTMLElement>;
}
