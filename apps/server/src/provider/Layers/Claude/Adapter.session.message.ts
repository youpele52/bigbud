import type { ProviderSendTurnInput } from "@bigbud/contracts";
import { Effect, type FileSystem } from "effect";

import { resolveAttachmentPath } from "../../../attachments/attachmentStore.ts";
import {
  appendAttachedImageOcrContents,
  extractPromptTextFromFile,
} from "../../../attachments/documentText.ts";
import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../../Errors.ts";
import {
  buildClaudeImageContentBlock,
  buildPromptText,
  buildUserMessage,
  SUPPORTED_CLAUDE_IMAGE_MIME_TYPES,
  toMessage,
} from "./Adapter.utils.ts";

export interface BuildUserMessageDeps {
  readonly fileSystem: FileSystem.FileSystem;
  readonly serverConfig: { readonly attachmentsDir: string };
}

export const makeBuildUserMessageEffect = (deps: BuildUserMessageDeps) => {
  const { fileSystem, serverConfig } = deps;
  return Effect.fn("buildUserMessageEffect")(function* (input: ProviderSendTurnInput) {
    const imageOcrBlocks: Array<{ readonly fileName: string; readonly text: string }> = [];
    const sdkContent: Array<Record<string, unknown>> = [];

    for (const attachment of input.attachments ?? []) {
      if (attachment.type === "path") continue;
      if (attachment.type === "image") {
        if (!SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(attachment.mimeType)) {
          return yield* new ProviderAdapterValidationError({
            provider: "claudeAgent",
            operation: "turn/start",
            issue: `Unsupported Claude image attachment type '${attachment.mimeType}'.`,
          });
        }

        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          return yield* new ProviderAdapterRequestError({
            provider: "claudeAgent",
            method: "turn/start",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }

        const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: "claudeAgent",
                method: "turn/start",
                detail: toMessage(cause, "Failed to read attachment file."),
                cause,
              }),
          ),
        );

        const extractedText = yield* Effect.tryPromise({
          try: () =>
            extractPromptTextFromFile({
              filePath: attachmentPath,
              mimeType: attachment.mimeType,
              fileName: attachment.name,
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: "claudeAgent",
              method: "turn/start",
              detail: toMessage(cause, "Failed to extract OCR text from image attachment."),
              cause,
            }),
        });
        if (extractedText !== null) {
          imageOcrBlocks.push({ fileName: attachment.name, text: extractedText });
        }

        sdkContent.push(
          buildClaudeImageContentBlock({
            mimeType: attachment.mimeType,
            bytes,
          }),
        );
        continue;
      }

      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        return yield* new ProviderAdapterRequestError({
          provider: "claudeAgent",
          method: "turn/start",
          detail: `Invalid file attachment id '${attachment.id}'.`,
        });
      }

      const fileBytes = yield* fileSystem.readFile(attachmentPath).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: "claudeAgent",
              method: "turn/start",
              detail: toMessage(cause, "Failed to read file attachment."),
              cause,
            }),
        ),
      );

      sdkContent.push({
        type: "document",
        source: {
          type: "base64",
          media_type: attachment.mimeType,
          data: Buffer.from(fileBytes).toString("base64"),
        },
        title: attachment.name,
      });
    }

    const text = appendAttachedImageOcrContents(buildPromptText(input), imageOcrBlocks);
    if (text.length > 0) {
      sdkContent.unshift({ type: "text", text });
    }

    return buildUserMessage({ sdkContent });
  });
};
