import { providerAttachmentIssue } from "@bigbud/shared/providerAttachments";

import { parseStandaloneComposerSlashCommand } from "../../../logic/composer";
import {
  appendTerminalContextsToPrompt,
  type TerminalContextDraft,
} from "../../../lib/terminalContext";
import type { readNativeApi } from "../../../rpc/nativeApi";
import { toastManager } from "../../ui/toast";

import {
  appendBrowserAnnotationsToPrompt,
  buildExpiredTerminalContextToastCopy,
  deriveComposerSendState,
  formatOutgoingPrompt,
} from "./ChatView.logic";
import { IMAGE_ONLY_BOOTSTRAP_PROMPT } from "./ChatView.sendTurn.helpers";
import { formatReadDocumentPrompt, parseReadDocumentCommand } from "./ChatView.sendTurn.read";
import type { UseOnSendInput } from "./ChatView.sendTurn.types";

/** A composer prompt ready to send or queue, with the draft snapshot needed to restore it. */
export interface PreparedComposerPrompt {
  /** Raw composer text, restored into the draft when the send fails. */
  readonly promptText: string;
  /** Text after `/read` expansion and `transformPromptForSend`, before contexts are appended. */
  readonly transformedPromptText: string;
  /** Final message text, including terminal contexts, annotations, and prompt formatting. */
  readonly outgoingMessageText: string;
  readonly images: UseOnSendInput["composerImages"];
  readonly files: UseOnSendInput["composerFiles"];
  readonly annotations: UseOnSendInput["composerAnnotations"];
  readonly terminalContexts: TerminalContextDraft[];
  readonly expiredTerminalContextCount: number;
}

/**
 * Shared front half of every composer send: attachment validation, standalone slash commands,
 * `/read`, prompt transforms, terminal contexts, annotations, and outgoing formatting. Returns
 * `null` when the composer input was handled here or cannot be sent.
 */
export async function prepareComposerPrompt(input: {
  readonly api: NonNullable<ReturnType<typeof readNativeApi>>;
  readonly sendInput: UseOnSendInput;
  readonly resetComposerDraft: () => void;
}): Promise<PreparedComposerPrompt | null> {
  const { api, sendInput } = input;
  const {
    activeThread: thread,
    promptRef,
    composerImages,
    composerFiles,
    composerAnnotations,
    composerTerminalContexts,
    selectedProvider,
    selectedModel,
    selectedProviderModels,
    selectedPromptEffort,
    selectedModelSelection,
  } = sendInput;
  if (!thread) return null;
  const attachmentIssue = providerAttachmentIssue(selectedProvider, [
    ...composerImages,
    ...composerFiles,
  ]);
  if (attachmentIssue) {
    sendInput.setThreadError(thread.id, attachmentIssue);
    return null;
  }

  const promptText = promptRef.current;
  const {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent,
  } = deriveComposerSendState({
    prompt: promptText,
    imageCount: composerImages.length,
    fileCount: composerFiles.length,
    annotationCount: composerAnnotations.length,
    terminalContexts: composerTerminalContexts,
  });

  const standaloneSlashCommand =
    composerImages.length === 0 &&
    composerFiles.length === 0 &&
    composerAnnotations.length === 0 &&
    sendableTerminalContexts.length === 0
      ? parseStandaloneComposerSlashCommand(trimmedPrompt)
      : null;
  if (standaloneSlashCommand) {
    if (standaloneSlashCommand === "plan" || standaloneSlashCommand === "default") {
      sendInput.handleInteractionModeChange(standaloneSlashCommand);
    }
    input.resetComposerDraft();
    return null;
  }

  const readDocumentCommand = parseReadDocumentCommand(trimmedPrompt);
  if (!hasSendableContent) {
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(expiredTerminalContextCount, "empty");
      toastManager.add({
        type: "warning",
        title: toastCopy.title,
        description: toastCopy.description,
      });
    }
    return null;
  }
  if (!sendInput.activeProject) return null;

  const promptTextForSend = readDocumentCommand
    ? await api.server
        .readDocumentUrl({ url: readDocumentCommand.url })
        .then(formatReadDocumentPrompt)
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not read document URL",
            description: error instanceof Error ? error.message : "Check the URL and try again.",
          });
          return null;
        })
    : promptText;
  if (!promptTextForSend) return null;
  const transformedPromptText = sendInput.transformPromptForSend
    ? sendInput.transformPromptForSend(promptTextForSend)
    : promptTextForSend;

  const terminalContexts = [...sendableTerminalContexts];
  const annotations = [...composerAnnotations];
  const messageText = appendBrowserAnnotationsToPrompt(
    appendTerminalContextsToPrompt(transformedPromptText, terminalContexts),
    annotations,
  );
  const outgoingMessageText = formatOutgoingPrompt({
    provider: selectedProvider,
    model: selectedModel,
    models: selectedProviderModels,
    effort: selectedPromptEffort,
    text: messageText || IMAGE_ONLY_BOOTSTRAP_PROMPT,
    subProviderID:
      "subProviderID" in selectedModelSelection ? selectedModelSelection.subProviderID : undefined,
  });
  return {
    promptText,
    transformedPromptText,
    outgoingMessageText,
    images: [...composerImages],
    files: [...composerFiles],
    annotations,
    terminalContexts,
    expiredTerminalContextCount,
  };
}

/** Warns that expired terminal contexts were left out of a prompt that was still sent. */
export function notifyOmittedTerminalContexts(expiredTerminalContextCount: number) {
  if (expiredTerminalContextCount === 0) return;
  const toastCopy = buildExpiredTerminalContextToastCopy(expiredTerminalContextCount, "omitted");
  toastManager.add({
    type: "warning",
    title: toastCopy.title,
    description: toastCopy.description,
  });
}
