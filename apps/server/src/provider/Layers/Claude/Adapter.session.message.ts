import type { ProviderSendTurnInput } from "@bigbud/contracts";
import type { ClaudeSdkUserContent } from "./Adapter.utils.message.ts";
import { Effect, type FileSystem } from "effect";

import { prepareManagedAttachmentContext } from "../../../attachments/providerAttachments.managed.ts";
import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../../Errors.ts";
import {
  buildClaudeImageContentBlock,
  buildPromptText,
  buildUserMessage,
  isClaudeImageMimeType,
  toMessage,
} from "./Adapter.utils.ts";

export interface BuildUserMessageDeps {
  readonly fileSystem: FileSystem.FileSystem;
  readonly serverConfig: { readonly attachmentsDir: string };
}

export const makeBuildUserMessageEffect = (deps: BuildUserMessageDeps) => {
  const { serverConfig } = deps;
  return Effect.fn("buildUserMessageEffect")(function* (
    input: ProviderSendTurnInput,
    pathReachable = true,
  ) {
    const prepared = yield* Effect.tryPromise({
      try: () =>
        prepareManagedAttachmentContext(
          buildPromptText(input),
          input.attachments ?? [],
          serverConfig.attachmentsDir,
          pathReachable,
        ),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: "claudeAgent",
          method: "turn/start",
          detail: toMessage(cause, "Failed to prepare attachments."),
          cause,
        }),
    });
    const sdkContent: Array<ClaudeSdkUserContent[number]> = [];

    for (const { attachment, bytes } of prepared.attachments) {
      if (attachment.type === "image") {
        if (!isClaudeImageMimeType(attachment.mimeType)) {
          return yield* new ProviderAdapterValidationError({
            provider: "claudeAgent",
            operation: "turn/start",
            issue: `Unsupported Claude image attachment type '${attachment.mimeType}'.`,
          });
        }

        sdkContent.push(
          buildClaudeImageContentBlock({
            mimeType: attachment.mimeType,
            bytes,
          }),
        );
        continue;
      }

      if (attachment.mimeType !== "application/pdf") continue;

      sdkContent.push({
        type: "document",
        source: {
          type: "base64",
          media_type: attachment.mimeType,
          data: bytes.toString("base64"),
        },
        title: attachment.name,
      });
    }

    const text = prepared.text;
    if (text.length > 0) {
      sdkContent.unshift({ type: "text", text });
    }

    return buildUserMessage({ sdkContent });
  });
};
