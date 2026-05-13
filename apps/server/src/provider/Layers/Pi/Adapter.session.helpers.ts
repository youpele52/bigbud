import { readFile } from "node:fs/promises";

import { type ChatAttachment } from "@bigbud/contracts";
import { Effect } from "effect";

import { resolveAttachmentPath } from "../../../attachments/attachmentStore.ts";
import {
  appendAttachedFileContents,
  appendUnextractableFileNotice,
  extractPromptTextFromFile,
} from "../../../attachments/documentText.ts";
import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../../Errors.ts";
import type { ActivePiSession, PiEmitEvents, PiSyntheticEventFn } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import type { PiRpcImage, PiRpcSessionState } from "./RpcProcess.ts";
import {
  isPiModelSelection,
  normalizeString,
  resolvePiProviderForModel,
  toMessage,
} from "./Adapter.utils.ts";

export const refreshSessionState = Effect.fn("refreshSessionState")(function* (
  session: ActivePiSession,
) {
  const response = yield* Effect.tryPromise({
    try: () => session.process.request<PiRpcSessionState>({ type: "get_state" }),
    catch: (cause) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "get_state",
        detail: toMessage(cause, "Failed to query Pi session state."),
        cause,
      }),
  });

  const state = response.data;
  session.model = normalizeString(state?.model?.id) ?? session.model;
  session.providerID = normalizeString(state?.model?.provider) ?? session.providerID;
  session.thinkingLevel = normalizeString(state?.thinkingLevel) ?? session.thinkingLevel;
  session.sessionId = normalizeString(state?.sessionId) ?? session.sessionId;
  session.sessionFile = normalizeString(state?.sessionFile) ?? session.sessionFile;
  session.updatedAt = new Date().toISOString();
  return state;
});

export function appendPiAttachmentInstructions(input: {
  readonly prompt: string;
  readonly hasFileAttachments: boolean;
}): string {
  if (!input.hasFileAttachments) return input.prompt;

  const instruction =
    "<attachment_handling_instructions>\n" +
    "Use attached document content only when it appears in <attached_file_contents>. " +
    "Do not call file-reading tools on attachment paths or try to inspect raw PDF/DOCX bytes. " +
    "If a document appears in <unreadable_attached_files>, tell the user that text extraction failed and ask for OCR or a text-readable version if the document contents are required.\n" +
    "</attachment_handling_instructions>";
  return input.prompt.length > 0 ? `${input.prompt}\n\n${instruction}` : instruction;
}

export function buildResumeCursor(session: ActivePiSession) {
  return {
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
  };
}

export const applyModelSelection = Effect.fn("applyModelSelection")(function* (input: {
  readonly session: ActivePiSession;
  readonly modelSelection: unknown;
}) {
  if (!isPiModelSelection(input.modelSelection)) {
    return;
  }

  const subProviderID = normalizeString(input.modelSelection.subProviderID);
  const fallback = input.session.providerID;
  const resolved = resolvePiProviderForModel({
    model: input.modelSelection.model,
    ...(subProviderID ? { subProviderID } : {}),
    ...(fallback ? { fallback } : {}),
  });
  if (!resolved) {
    return yield* new ProviderAdapterValidationError({
      provider: PROVIDER,
      operation: "sendTurn",
      issue: `Unable to resolve Pi provider for model '${input.modelSelection.model}'.`,
    });
  }

  if (input.session.model !== resolved.modelId || input.session.providerID !== resolved.provider) {
    yield* Effect.tryPromise({
      try: () =>
        input.session.process.request({
          type: "set_model",
          provider: resolved.provider,
          modelId: resolved.modelId,
        }),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "set_model",
          detail: toMessage(cause, "Failed to apply Pi model selection."),
          cause,
        }),
    });
    input.session.model = resolved.modelId;
    input.session.providerID = resolved.provider;
  }

  const nextThinkingLevel = normalizeString(input.modelSelection.options?.thinkingLevel);
  if (nextThinkingLevel && nextThinkingLevel !== input.session.thinkingLevel) {
    yield* Effect.tryPromise({
      try: () =>
        input.session.process.request({
          type: "set_thinking_level",
          level: nextThinkingLevel,
        }),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "set_thinking_level",
          detail: toMessage(cause, "Failed to apply Pi thinking level."),
          cause,
        }),
    });
    input.session.thinkingLevel = nextThinkingLevel;
  }
});

export const makeResolveImages = (attachmentsDir: string) =>
  Effect.fn("resolveImages")(function* (attachments: ReadonlyArray<ChatAttachment>) {
    const images: PiRpcImage[] = [];

    for (const attachment of attachments) {
      if (attachment.type !== "image") {
        continue;
      }

      const attachmentPath = resolveAttachmentPath({
        attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "prompt",
          detail: `Invalid attachment id '${String(attachment.id)}'.`,
        });
      }

      const bytes = yield* Effect.tryPromise({
        try: () => readFile(attachmentPath),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "prompt",
            detail: `Failed to read attachment '${String(attachment.id)}'.`,
            cause,
          }),
      });

      images.push({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: attachment.mimeType,
      });
    }

    return images;
  });

/**
 * Reads text-extractable file attachments from the attachmentsDir and returns a
 * string block to append to the Pi prompt so the model can see the file contents.
 * Files with no extractable text are skipped — Pi has no document API and cannot
 * interpret opaque binary data.
 */
export const makeAppendTextFileAttachments = (attachmentsDir: string) =>
  Effect.fn("appendTextFileAttachments")(function* (
    attachments: ReadonlyArray<ChatAttachment>,
    prompt: string,
  ) {
    const textBlocks: Array<{ readonly fileName: string; readonly text: string }> = [];
    const unextractableFiles: Array<{ readonly fileName: string; readonly mimeType: string }> = [];

    for (const attachment of attachments) {
      if (attachment.type !== "file") continue;

      const attachmentPath = resolveAttachmentPath({ attachmentsDir, attachment });
      if (!attachmentPath) continue;

      const extractedText = yield* Effect.tryPromise({
        try: () =>
          extractPromptTextFromFile({
            filePath: attachmentPath,
            mimeType: attachment.mimeType,
            fileName: attachment.name,
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "prompt",
            detail: `Failed to extract text from file attachment '${attachment.name}' for Pi.`,
            cause,
          }),
      });
      if (extractedText === null) {
        unextractableFiles.push({ fileName: attachment.name, mimeType: attachment.mimeType });
        continue;
      }

      textBlocks.push({ fileName: attachment.name, text: extractedText });
    }

    return appendUnextractableFileNotice(
      appendAttachedFileContents(prompt, textBlocks),
      unextractableFiles,
    );
  });

export function makeStopSessionRecord(deps: {
  readonly emit: PiEmitEvents;
  readonly makeSyntheticEvent: PiSyntheticEventFn;
}) {
  return Effect.fn("stopSessionRecord")(function* (session: ActivePiSession) {
    session.unsubscribe();

    const pending = [...session.pendingUserInputs.values()];
    session.pendingUserInputs.clear();
    for (const request of pending) {
      yield* deps.emit([
        yield* deps.makeSyntheticEvent(
          session.threadId,
          "user-input.resolved",
          { answers: {} },
          {
            ...(request.turnId ? { turnId: request.turnId } : {}),
            requestId: request.requestId,
          },
        ),
      ]);
    }

    yield* Effect.tryPromise({
      try: () => session.process.stop(),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.stop",
          detail: toMessage(cause, "Failed to stop Pi session."),
          cause,
        }),
    }).pipe(Effect.orElseSucceed(() => undefined));
  });
}
