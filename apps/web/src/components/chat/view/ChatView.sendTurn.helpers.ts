import type {
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadTurnStartBootstrap,
} from "@bigbud/contracts";
import { buildTemporaryWorktreeBranchName } from "@bigbud/shared/git";
import { collapseExpandedComposerCursor, detectComposerTrigger } from "../../../logic/composer";
import { buildExplicitExecutionTargets } from "../../../lib/providerExecutionTargets";
import type { TerminalContextDraft } from "../../../lib/terminalContext";
import type { ChatAttachment, ChatMessage, Project, Thread } from "../../../models/types";
import type {
  ComposerAnnotationAttachment,
  ComposerFileAttachment,
  ComposerImageAttachment,
} from "../../../stores/composer";
import { isElectron } from "~/config/env/env.config";
import {
  cloneComposerImageForRetry,
  readFileAsDataUrl,
  type revokeUserMessagePreviewUrls,
} from "./ChatView.logic";
import { DEFAULT_THREAD_TITLE, draftTitleFromMessage } from "./ChatView.threadTitle.logic";

export const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";

export function resolveSendContext(input: {
  readonly thread: Thread;
  readonly isServer: boolean;
  readonly envMode: string;
}) {
  const isFirstMessage = !input.isServer || input.thread.messages.length === 0;
  const baseBranchForWorktree =
    isFirstMessage && input.envMode === "worktree" && !input.thread.worktreePath
      ? input.thread.branch
      : null;

  return {
    threadIdForSend: input.thread.id,
    isFirstMessage,
    baseBranchForWorktree,
    shouldCreateWorktree:
      isFirstMessage && input.envMode === "worktree" && !input.thread.worktreePath,
  };
}

export function getWorktreeValidationError(input: {
  readonly shouldCreateWorktree: boolean;
  readonly thread: Thread;
  readonly project: Project | undefined;
}): string | null {
  if (!input.shouldCreateWorktree) {
    return null;
  }
  if (!input.thread.branch) {
    return "Select a base branch before sending in New worktree mode.";
  }
  if (!input.project?.cwd) {
    return "New worktree mode is unavailable for chats without a project folder.";
  }
  return null;
}

export function buildThreadBootstrap(input: {
  readonly thread: Thread;
  readonly project: Project;
  readonly isDraft: boolean;
  readonly isFirstMessage: boolean;
  readonly promptText: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly baseBranchForWorktree: string | null;
}): ThreadTurnStartBootstrap | undefined {
  const seededTitle =
    input.isFirstMessage && (input.isDraft || input.thread.title.trim() === DEFAULT_THREAD_TITLE)
      ? draftTitleFromMessage(input.promptText)
      : undefined;
  const executionTargets = buildExplicitExecutionTargets({
    providerRuntimeExecutionTargetId:
      input.thread.providerRuntimeExecutionTargetId ??
      input.project.providerRuntimeExecutionTargetId,
    workspaceExecutionTargetId:
      input.thread.workspaceExecutionTargetId ?? input.project.workspaceExecutionTargetId,
  });

  if (!input.isDraft && !input.baseBranchForWorktree) {
    return undefined;
  }

  return {
    ...(input.isDraft
      ? {
          createThread: {
            projectId: input.project.id,
            title: seededTitle ?? input.thread.title,
            ...executionTargets,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            branch: input.thread.branch,
            worktreePath: input.thread.worktreePath,
            createdAt: input.thread.createdAt,
          },
        }
      : {}),
    ...(input.baseBranchForWorktree
      ? {
          prepareWorktree: {
            projectCwd: input.project.cwd!,
            baseBranch: input.baseBranchForWorktree,
            branch: buildTemporaryWorktreeBranchName(),
          },
          runSetupScript: true,
        }
      : {}),
  };
}

export function buildOptimisticAttachments(
  images: readonly ComposerImageAttachment[],
  files: readonly ComposerFileAttachment[],
): ChatAttachment[] {
  return [
    ...images.map((image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.previewUrl,
    })),
    ...files.map((file) => ({
      type: "file" as const,
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      ...(file.filePath ? { sourcePath: file.filePath } : {}),
    })),
  ];
}

export function buildTurnAttachments(
  images: readonly ComposerImageAttachment[],
  files: readonly ComposerFileAttachment[],
) {
  return Promise.all([
    ...images.map(async (image) => ({
      type: "image" as const,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: await readFileAsDataUrl(image.file),
    })),
    ...files.map(async (file) => {
      if (isElectron && file.filePath) {
        return {
          type: "file" as const,
          transport: "path" as const,
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          filePath: file.filePath,
        };
      }
      if (isElectron) {
        throw new Error(`Missing filesystem path for attachment '${file.name}'.`);
      }
      const dataUrl = file.file ? await readFileAsDataUrl(file.file) : "";
      return {
        type: "file" as const,
        transport: "base64" as const,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        dataUrl,
      };
    }),
  ]);
}

export function restoreShellComposerDraftAfterFailure(input: {
  readonly currentDraftEmpty: boolean;
  readonly messageIdForSend: string;
  readonly promptText: string;
  readonly promptRef: { current: string };
  readonly setOptimisticUserMessages: (updater: (existing: ChatMessage[]) => ChatMessage[]) => void;
  readonly setPrompt: (prompt: string) => void;
  readonly setComposerShellMode: (shellMode: boolean) => void;
  readonly setComposerCursor: (next: number) => void;
  readonly setComposerTrigger: (trigger: null) => void;
}) {
  if (!input.currentDraftEmpty) {
    return;
  }

  input.setOptimisticUserMessages((existing) =>
    existing.filter((message) => message.id !== input.messageIdForSend),
  );
  input.promptRef.current = input.promptText;
  input.setPrompt(input.promptText);
  input.setComposerShellMode(true);
  input.setComposerCursor(
    collapseExpandedComposerCursor(input.promptText, input.promptText.length),
  );
  input.setComposerTrigger(null);
}

export function restoreMessageComposerDraftAfterFailure(input: {
  readonly currentDraftEmpty: boolean;
  readonly messageIdForSend: string;
  readonly promptText: string;
  readonly promptRef: { current: string };
  readonly replyTarget: ChatMessage["replyTo"] | null;
  readonly composerImages: readonly ComposerImageAttachment[];
  readonly composerFiles: readonly ComposerFileAttachment[];
  readonly composerAnnotations: readonly ComposerAnnotationAttachment[];
  readonly composerTerminalContexts: readonly TerminalContextDraft[];
  readonly setOptimisticUserMessages: (updater: (existing: ChatMessage[]) => ChatMessage[]) => void;
  readonly revokeUserMessagePreviewUrls: typeof revokeUserMessagePreviewUrls;
  readonly setPrompt: (prompt: string) => void;
  readonly setComposerCursor: (next: number) => void;
  readonly addComposerImagesToDraft: (images: ComposerImageAttachment[]) => void;
  readonly addComposerFilesToDraft: (files: ComposerFileAttachment[]) => void;
  readonly addComposerAnnotationsToDraft: (annotations: ComposerAnnotationAttachment[]) => void;
  readonly addComposerTerminalContextsToDraft: (contexts: TerminalContextDraft[]) => void;
  readonly setReplyTarget: (replyTarget: ChatMessage["replyTo"] | null) => void;
  readonly setComposerTrigger: (trigger: ReturnType<typeof detectComposerTrigger>) => void;
}) {
  if (!input.currentDraftEmpty) {
    return;
  }

  input.setOptimisticUserMessages((existing) => {
    const removed = existing.filter((message) => message.id === input.messageIdForSend);
    for (const message of removed) {
      input.revokeUserMessagePreviewUrls(message);
    }
    const next = existing.filter((message) => message.id !== input.messageIdForSend);
    return next.length === existing.length ? existing : next;
  });
  input.promptRef.current = input.promptText;
  input.setPrompt(input.promptText);
  input.setComposerCursor(
    collapseExpandedComposerCursor(input.promptText, input.promptText.length),
  );
  input.addComposerImagesToDraft(input.composerImages.map(cloneComposerImageForRetry));
  input.addComposerFilesToDraft(Array.from(input.composerFiles));
  input.addComposerAnnotationsToDraft(Array.from(input.composerAnnotations));
  input.addComposerTerminalContextsToDraft(Array.from(input.composerTerminalContexts));
  input.setReplyTarget(input.replyTarget);
  input.setComposerTrigger(detectComposerTrigger(input.promptText, input.promptText.length));
}
