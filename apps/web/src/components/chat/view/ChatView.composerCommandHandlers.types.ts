import { type ProviderInteractionMode, type ProviderKind, type ThreadId } from "@bigbud/contracts";
import { type ComposerTrigger } from "../../../logic/composer";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../../logic/user-input";
import { type TerminalContextDraft } from "../../../lib/terminalContext";
import type { ComposerCommandItem } from "../composer/ComposerCommandMenu";
import type { ComposerPromptEditorHandle } from "../composer/ComposerPromptEditor";

export interface UseComposerCommandHandlersInput {
  composerMenuOpenRef: React.MutableRefObject<boolean>;
  composerMenuItemsRef: React.MutableRefObject<ComposerCommandItem[]>;
  activeComposerMenuItemRef: React.MutableRefObject<ComposerCommandItem | null>;
  composerSelectLockRef: React.MutableRefObject<boolean>;
  composerEditorRef: React.RefObject<ComposerPromptEditorHandle | null>;
  promptRef: React.MutableRefObject<string>;
  composerCursor: number;
  composerTerminalContexts: TerminalContextDraft[];
  composerMenuItems: ComposerCommandItem[];
  composerHighlightedItemId: string | null;
  isComposerShellMode: boolean;
  interactionMode: ProviderInteractionMode;
  activePendingProgress: ReturnType<typeof derivePendingUserInputProgress> | null;
  activePendingUserInput: { requestId: string } | null;
  isOpencodePendingUserInputMode: boolean;
  setComposerCursor: React.Dispatch<React.SetStateAction<number>>;
  setComposerTrigger: React.Dispatch<React.SetStateAction<ComposerTrigger | null>>;
  setComposerHighlightedItemId: React.Dispatch<React.SetStateAction<string | null>>;
  setComposerShellMode: (shellMode: boolean) => void;
  setComposerDraftTerminalContexts: (threadId: ThreadId, contexts: TerminalContextDraft[]) => void;
  threadId: ThreadId;
  setPrompt: (prompt: string) => void;
  setPendingUserInputAnswersByRequestId: React.Dispatch<
    React.SetStateAction<Record<string, Record<string, PendingUserInputDraftAnswer>>>
  >;
  applyPromptReplacement: (
    rangeStart: number,
    rangeEnd: number,
    replacement: string,
    options?: { expectedText?: string },
  ) => boolean;
  onProviderModelSelect: (provider: ProviderKind, model: string, subProviderID?: string) => void;
  handleInteractionModeChange: (mode: ProviderInteractionMode) => void;
  toggleInteractionMode: () => void;
  onOpenReadDialog: () => void;
  onSend: (e?: { preventDefault: () => void }) => void;
  onChangeActivePendingUserInputCustomAnswer: (
    questionId: string,
    value: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
  ) => void;
}
