import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type UserInputQuestion,
} from "@bigbud/contracts";
import { useCallback } from "react";
import {
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  replaceTextRange,
} from "../../../logic/composer";
import {
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  withPendingUserInputDraftAnswer,
} from "../../../logic/user-input/pending.logic";
import { toastManager } from "../../ui/toast";
import { randomUUID } from "~/lib/utils";
import { desktopAttachmentPath } from "./ChatView.attachments.logic";
import {
  type ComposerImageAttachment,
  type ComposerFileAttachment,
} from "../../../stores/composer";
import type {
  UseAddComposerFilesInput,
  UseAddComposerImagesInput,
  UseApplyPromptReplacementInput,
  UsePendingUserInputHandlersInput,
  UsePendingUserInputStateResult,
} from "./ChatView.composerHandlers.types";

export type {
  UseAddComposerFilesInput,
  UseAddComposerImagesInput,
  UseApplyPromptReplacementInput,
  UsePendingUserInputHandlersInput,
  UsePendingUserInputStateResult,
} from "./ChatView.composerHandlers.types";

const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;
const FILE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_FILE_BYTES / (1024 * 1024))}MB`;

/** Returns an `addComposerImages` handler bound to the current draft state. */
export function useAddComposerImages(input: UseAddComposerImagesInput) {
  const { activeThreadId, composerImagesRef, addComposerImage, addComposerImagesToDraft } = input;

  return useCallback(
    (files: File[]) => {
      if (!activeThreadId || files.length === 0) return;

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
      if (error)
        toastManager.add({ type: "error", title: "Could not attach image", description: error });
    },
    [activeThreadId, composerImagesRef, addComposerImage, addComposerImagesToDraft],
  );
}

export type ComposerFileAddMode = "atomic" | { readonly readDocumentText: string };

/** Returns an `addComposerFiles` handler bound to the current draft state. */
export function useAddComposerFiles(input: UseAddComposerFilesInput) {
  const {
    activeThreadId,
    composerFilesRef,
    composerImagesLength,
    addComposerFile,
    addComposerFilesToDraft,
    isElectron,
  } = input;

  return useCallback(
    (files: File[], mode?: ComposerFileAddMode) => {
      if (!activeThreadId || files.length === 0) return false;

      const nextFiles: ComposerFileAttachment[] = [];
      const paths = mode ? new Set(composerFilesRef.current.map((file) => file.filePath)) : null;
      let nextCount = composerFilesRef.current.length + composerImagesLength;
      let error: string | null = null;

      for (const file of files) {
        const filePath = isElectron && typeof mode !== "object" ? desktopAttachmentPath(file) : "";
        if (filePath && paths?.has(filePath)) {
          error = `'${file.name}' is already attached.`;
          break;
        }
        if (filePath) paths?.add(filePath);
        if (file.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
          if (!isElectron) {
            toastManager.add({
              type: "error",
              title: `Files over ${FILE_SIZE_LIMIT_LABEL} require the desktop app`,
            });
          } else {
            error = `'${file.name}' exceeds the ${FILE_SIZE_LIMIT_LABEL} attachment limit.`;
          }
          if (mode) break;
          continue;
        }
        if (nextCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
          error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`;
          break;
        }

        nextFiles.push({
          type: "file",
          id: randomUUID(),
          name: file.name || "file",
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          entryKind: "file",
          attachmentMode: "upload",
          filePath,
          file,
          ...(typeof mode === "object" ? { readDocumentText: mode.readDocumentText } : {}),
        });
        nextCount += 1;
      }

      if (error)
        toastManager.add({ type: "error", title: "Could not attach file", description: error });
      if (mode && nextFiles.length !== files.length) return false;
      if (nextFiles.length === 1 && nextFiles[0]) {
        addComposerFile(nextFiles[0]);
      } else if (nextFiles.length > 1) {
        addComposerFilesToDraft(nextFiles);
      }
      return nextFiles.length > 0;
    },
    [
      activeThreadId,
      composerFilesRef,
      composerImagesLength,
      addComposerFile,
      addComposerFilesToDraft,
      isElectron,
    ],
  );
}

/** Returns an `applyPromptReplacement` helper that edits the composer text in-place. */
export function useApplyPromptReplacement(input: UseApplyPromptReplacementInput) {
  const { promptRef, setPrompt, setComposerCursor, setComposerTrigger, composerEditorRef } = input;

  return useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string; focusComposer?: boolean },
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
      setPrompt(next.text);
      setComposerCursor(nextCursor);
      setComposerTrigger(
        detectComposerTrigger(next.text, expandCollapsedComposerCursor(next.text, nextCursor)),
      );
      if (options?.focusComposer !== false) {
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAt(nextCursor);
        });
      }
      return true;
    },
    [promptRef, setPrompt, setComposerCursor, setComposerTrigger, composerEditorRef],
  );
}

/** Returns handlers for interacting with pending user-input prompts.  */
export function usePendingUserInputHandlers(input: UsePendingUserInputHandlersInput) {
  const {
    activePendingUserInput,
    activePendingProgress,
    setPendingUserInputAnswersByRequestId,
    setPendingUserInputQuestionIndexByRequestId,
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
    (questionId: string, option: UserInputQuestion["options"][number], optionIndex: number) => {
      if (!activePendingUserInput) return;
      const question = activePendingUserInput.questions.find((entry) => entry.id === questionId);
      if (!question) return;
      const requestId = activePendingUserInput.requestId;
      setPendingUserInputAnswersByRequestId((existing) =>
        withPendingUserInputDraftAnswer(
          existing,
          requestId,
          questionId,
          togglePendingUserInputOptionSelection(
            question,
            existing[requestId]?.[questionId],
            option,
            optionIndex,
          ),
        ),
      );
    },
    [activePendingUserInput, setPendingUserInputAnswersByRequestId],
  );

  /** Mirrors editor text into the active question's draft; the editor itself owns the text. */
  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (questionId: string, value: string) => {
      if (!activePendingUserInput) return;
      const requestId = activePendingUserInput.requestId;
      const question = activePendingUserInput.questions.find((entry) => entry.id === questionId);
      setPendingUserInputAnswersByRequestId((existing) =>
        withPendingUserInputDraftAnswer(
          existing,
          requestId,
          questionId,
          setPendingUserInputCustomAnswer(existing[requestId]?.[questionId], value, question),
        ),
      );
    },
    [activePendingUserInput, setPendingUserInputAnswersByRequestId],
  );

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) return;
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  return {
    setActivePendingUserInputQuestionIndex,
    onToggleActivePendingUserInputOption,
    onChangeActivePendingUserInputCustomAnswer,
    onPreviousActivePendingUserInputQuestion,
  };
}
