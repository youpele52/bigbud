import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type ApprovalRequestId,
  type ThreadId,
  type UserInputQuestion,
} from "@bigbud/contracts";
import { useCallback } from "react";
import {
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  replaceTextRange,
} from "../../../logic/composer";
import {
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../../logic/user-input";
import { toastManager } from "../../ui/toast";
import { randomUUID } from "~/lib/utils";
import {
  type ComposerImageAttachment,
  type ComposerFileAttachment,
} from "../../../stores/composer";
import type { ComposerPromptEditorHandle } from "../composer/ComposerPromptEditor";

const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;
const FILE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_FILE_BYTES / (1024 * 1024))}MB`;

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

/** Returns an `addComposerImages` handler bound to the current draft state. */
export function useAddComposerImages(input: UseAddComposerImagesInput) {
  const {
    activeThreadId,
    composerImagesRef,
    pendingUserInputsLength,
    addComposerImage,
    addComposerImagesToDraft,
    setThreadError,
  } = input;

  return useCallback(
    (files: File[]) => {
      if (!activeThreadId || files.length === 0) return;

      if (pendingUserInputsLength > 0) {
        toastManager.add({
          type: "error",
          title: "Attach images after answering plan questions.",
        });
        return;
      }

      const nextImages: ComposerImageAttachment[] = [];
      let nextImageCount = composerImagesRef.current.length;
      let error: string | null = null;
      for (const file of files) {
        if (!file.type.startsWith("image/")) {
          error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
          continue;
        }
        if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
          error = `'${file.name}' exceeds the ${IMAGE_SIZE_LIMIT_LABEL} attachment limit.`;
          continue;
        }
        if (nextImageCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
          error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
          break;
        }

        const previewUrl = URL.createObjectURL(file);
        nextImages.push({
          type: "image",
          id: randomUUID(),
          name: file.name || "image",
          mimeType: file.type,
          sizeBytes: file.size,
          previewUrl,
          file,
        });
        nextImageCount += 1;
      }

      if (nextImages.length === 1 && nextImages[0]) {
        addComposerImage(nextImages[0]);
      } else if (nextImages.length > 1) {
        addComposerImagesToDraft(nextImages);
      }
      setThreadError(activeThreadId, error);
    },
    [
      activeThreadId,
      composerImagesRef,
      pendingUserInputsLength,
      addComposerImage,
      addComposerImagesToDraft,
      setThreadError,
    ],
  );
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

/** Returns an `addComposerFiles` handler bound to the current draft state. */
export function useAddComposerFiles(input: UseAddComposerFilesInput) {
  const {
    activeThreadId,
    composerFilesRef,
    composerImagesLength,
    pendingUserInputsLength,
    addComposerFile,
    addComposerFilesToDraft,
    setThreadError,
    isElectron,
  } = input;

  return useCallback(
    (files: File[]) => {
      if (!activeThreadId || files.length === 0) return;

      if (pendingUserInputsLength > 0) {
        toastManager.add({
          type: "error",
          title: "Attach files after answering plan questions.",
        });
        return;
      }

      const nextFiles: ComposerFileAttachment[] = [];
      let nextCount = composerFilesRef.current.length + composerImagesLength;
      let error: string | null = null;

      for (const file of files) {
        if (file.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
          if (!isElectron) {
            toastManager.add({
              type: "error",
              title: `Files over ${FILE_SIZE_LIMIT_LABEL} require the desktop app`,
            });
          } else {
            error = `'${file.name}' exceeds the ${FILE_SIZE_LIMIT_LABEL} attachment limit.`;
          }
          continue;
        }
        if (nextCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
          error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`;
          break;
        }

        const filePath = isElectron ? (window.desktopBridge?.getFilePath(file) ?? "") : "";
        if (isElectron && filePath.length === 0) {
          error = `Failed to access the full path for '${file.name}'. Try re-attaching the file.`;
          continue;
        }

        nextFiles.push({
          type: "file",
          id: randomUUID(),
          name: file.name || "file",
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          filePath,
          file: isElectron ? null : file,
        });
        nextCount += 1;
      }

      if (nextFiles.length === 1 && nextFiles[0]) {
        addComposerFile(nextFiles[0]);
      } else if (nextFiles.length > 1) {
        addComposerFilesToDraft(nextFiles);
      }
      setThreadError(activeThreadId, error);
    },
    [
      activeThreadId,
      composerFilesRef,
      composerImagesLength,
      pendingUserInputsLength,
      addComposerFile,
      addComposerFilesToDraft,
      setThreadError,
      isElectron,
    ],
  );
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

/** Returns an `applyPromptReplacement` helper that edits the composer text in-place. */
export function useApplyPromptReplacement(input: UseApplyPromptReplacementInput) {
  const {
    promptRef,
    setPrompt,
    setComposerCursor,
    setComposerTrigger,
    activePendingProgress,
    activePendingUserInput,
    isOpencodePendingUserInputMode,
    setPendingUserInputAnswersByRequestId,
    composerEditorRef,
  } = input;

  return useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string },
    ): boolean => {
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
      promptRef.current = next.text;
      const activePendingQuestion = activePendingProgress?.activeQuestion;
      if (activePendingQuestion && activePendingUserInput && !isOpencodePendingUserInputMode) {
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [activePendingUserInput.requestId]: {
            ...existing[activePendingUserInput.requestId],
            [activePendingQuestion.id]: setPendingUserInputCustomAnswer(
              existing[activePendingUserInput.requestId]?.[activePendingQuestion.id],
              next.text,
            ),
          },
        }));
      } else {
        setPrompt(next.text);
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        detectComposerTrigger(next.text, expandCollapsedComposerCursor(next.text, nextCursor)),
      );
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCursor);
      });
      return true;
    },
    [
      promptRef,
      setPrompt,
      setComposerCursor,
      setComposerTrigger,
      activePendingProgress,
      activePendingUserInput,
      isOpencodePendingUserInputMode,
      setPendingUserInputAnswersByRequestId,
      composerEditorRef,
    ],
  );
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

/** Returns handlers for interacting with pending user-input prompts. */
export function usePendingUserInputHandlers(input: UsePendingUserInputHandlersInput) {
  const {
    activePendingUserInput,
    activePendingProgress,
    activePendingResolvedAnswers,
    promptRef,
    setComposerCursor,
    setComposerTrigger,
    setPendingUserInputAnswersByRequestId,
    setPendingUserInputQuestionIndexByRequestId,
    onRespondToUserInput,
  } = input;

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) return;
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput, setPendingUserInputQuestionIndexByRequestId],
  );

  const onToggleActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput) return;
      const question = activePendingUserInput.questions.find((entry) => entry.id === questionId);
      if (!question) return;
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: togglePendingUserInputOptionSelection(
            question,
            existing[activePendingUserInput.requestId]?.[questionId],
            optionLabel,
          ),
        },
      }));
      promptRef.current = "";
      setComposerCursor(0);
      setComposerTrigger(null);
    },
    [
      activePendingUserInput,
      promptRef,
      setComposerCursor,
      setComposerTrigger,
      setPendingUserInputAnswersByRequestId,
    ],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInput) return;
      promptRef.current = value;
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingUserInput.requestId]?.[questionId],
            value,
          ),
        },
      }));
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(value, expandedCursor),
      );
    },
    [
      activePendingUserInput,
      promptRef,
      setComposerCursor,
      setComposerTrigger,
      setPendingUserInputAnswersByRequestId,
    ],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || !activePendingProgress) return;
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) return;
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  return {
    setActivePendingUserInputQuestionIndex,
    onToggleActivePendingUserInputOption,
    onChangeActivePendingUserInputCustomAnswer,
    onAdvanceActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
  };
}
