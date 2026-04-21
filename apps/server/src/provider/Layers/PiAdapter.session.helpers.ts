import { readFile } from "node:fs/promises";

import { type ChatAttachment } from "@bigbud/contracts";
import { Effect } from "effect";

import { resolveAttachmentPath } from "../../attachments/attachmentStore.ts";
import { isTextReadable } from "../../attachments/fileMime.ts";
import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../Errors.ts";
import type { ActivePiSession, PiEmitEvents, PiSyntheticEventFn } from "./PiAdapter.types.ts";
import { PROVIDER } from "./PiAdapter.types.ts";
import type { PiRpcImage, PiRpcSessionState } from "./PiRpcProcess.ts";
import {
  isPiModelSelection,
  normalizeString,
  resolvePiProviderForModel,
  toMessage,
} from "./PiAdapter.utils.ts";

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
 * Reads text-based file attachments from the attachmentsDir and returns a
 * string block to append to the Pi prompt so the model can see the file contents.
 *
 * Binary files (PDF, Office docs, video, audio, archives) are skipped — Pi has
 * no document API and cannot interpret binary data.
 */
export const makeAppendTextFileAttachments = (attachmentsDir: string) =>
  Effect.fn("appendTextFileAttachments")(function* (
    attachments: ReadonlyArray<ChatAttachment>,
    prompt: string,
  ) {
    const textBlocks: string[] = [];

    for (const attachment of attachments) {
      if (attachment.type !== "file") continue;
      if (!isTextReadable(attachment.mimeType)) continue;

      const attachmentPath = resolveAttachmentPath({ attachmentsDir, attachment });
      if (!attachmentPath) continue;

      const bytes = yield* Effect.tryPromise({
        try: () => readFile(attachmentPath),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "prompt",
            detail: `Failed to read file attachment '${attachment.name}' for Pi.`,
            cause,
          }),
      });

      const content = bytes.toString("utf8");
      textBlocks.push(`<file name="${attachment.name}">\n${content}\n</file>`);
    }

    if (textBlocks.length === 0) return prompt;
    const block = `<attached_file_contents>\n${textBlocks.join("\n")}\n</attached_file_contents>`;
    return prompt.length > 0 ? `${prompt}\n\n${block}` : block;
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
