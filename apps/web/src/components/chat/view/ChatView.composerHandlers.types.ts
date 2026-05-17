import { type ApprovalRequestId, type ThreadId, type UserInputQuestion } from "@bigbud/contracts";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../../logic/user-input";
import { type ComposerTrigger } from "../../../logic/composer";
import type { ComposerImageAttachment, ComposerFileAttachment } from "../../../stores/composer";
import type { ComposerPromptEditorHandle } from "../composer/ComposerPromptEditor";

export interface UsePendingUserInputStateResult {
  pendingUserInputAnswersByRequestId: Record<string, Record<string, PendingUserInputDraftAnswer>>;
  pendingUserInputQuestionIndexByRequestId: Record<string, number>;
  setPendingUserInputAnswersByRequestId: React.Dispatch<
    React.SetStateAction<Record<string, Record<string, PendingUserInputDraftAnswer>>>
  >;
  setPendingUserInputQuestionIndexByRequestId: React.Dispatch<
    React.SetStateAction<Record<string, number>>
  >;
}

export interface UseAddComposerImagesInput {
  activeThreadId: ThreadId | null;
  composerImagesRef: React.MutableRefObject<ComposerImageAttachment[]>;
  pendingUserInputsLength: number;
  addComposerImage: (image: ComposerImageAttachment) => void;
  addComposerImagesToDraft: (images: ComposerImageAttachment[]) => void;
  setThreadError: (targetThreadId: ThreadId | null, error: string | null) => void;
}

export interface UseAddComposerFilesInput {
  activeThreadId: ThreadId | null;
  composerFilesRef: React.MutableRefObject<ComposerFileAttachment[]>;
  composerImagesLength: number;
  pendingUserInputsLength: number;
  addComposerFile: (file: ComposerFileAttachment) => void;
  addComposerFilesToDraft: (files: ComposerFileAttachment[]) => void;
  setThreadError: (targetThreadId: ThreadId | null, error: string | null) => void;
  isElectron: boolean;
}

export interface UseApplyPromptReplacementInput {
  promptRef: React.MutableRefObject<string>;
  setPrompt: (prompt: string) => void;
  setComposerCursor: React.Dispatch<React.SetStateAction<number>>;
  setComposerTrigger: React.Dispatch<React.SetStateAction<ComposerTrigger | null>>;
  activePendingProgress: ReturnType<typeof derivePendingUserInputProgress> | null;
  activePendingUserInput: { requestId: string } | null;
  isOpencodePendingUserInputMode: boolean;
  setPendingUserInputAnswersByRequestId: React.Dispatch<
    React.SetStateAction<Record<string, Record<string, PendingUserInputDraftAnswer>>>
  >;
  composerEditorRef: React.RefObject<ComposerPromptEditorHandle | null>;
}

export interface UsePendingUserInputHandlersInput {
  activePendingUserInput: {
    requestId: ApprovalRequestId;
    questions: ReadonlyArray<UserInputQuestion>;
  } | null;
  activePendingProgress: ReturnType<typeof derivePendingUserInputProgress> | null;
  activePendingResolvedAnswers: Record<string, string | string[]> | null;
  promptRef: React.MutableRefObject<string>;
  setComposerCursor: React.Dispatch<React.SetStateAction<number>>;
  setComposerTrigger: React.Dispatch<React.SetStateAction<ComposerTrigger | null>>;
  setPendingUserInputAnswersByRequestId: React.Dispatch<
    React.SetStateAction<Record<string, Record<string, PendingUserInputDraftAnswer>>>
  >;
  setPendingUserInputQuestionIndexByRequestId: React.Dispatch<
    React.SetStateAction<Record<string, number>>
  >;
  onRespondToUserInput: (
    requestId: ApprovalRequestId,
    answers: Record<string, unknown>,
  ) => Promise<void>;
}
