import { type ProviderSendTurnInput, ThreadId } from "@bigbud/contracts";
import { Effect, FileSystem } from "effect";

import { resolveAttachmentPath } from "../../../attachments/attachmentStore.ts";
import { isCodexModelSelectionError } from "../../../codex/codexAppServerManager.modelSelection.ts";
import {
  CodexRpcError,
  CodexSessionUnavailableError,
} from "../../../codex/codexAppServerManager.errors.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../../Errors.ts";
import { PROVIDER, toMessage } from "./Adapter.types.ts";

/**
 * Only typed local pre-dispatch absence is evidence that the turn never started.
 */
export function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  if (!(cause instanceof CodexSessionUnavailableError)) return undefined;
  if (cause.reason === "missing") {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      failureClass: "session-dead",
      cause,
    });
  }
  if (cause.reason === "closed") {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      failureClass: "session-dead",
      cause,
    });
  }
  return undefined;
}

function toModelSelectionError(
  operation: string,
  cause: unknown,
): ProviderAdapterValidationError | undefined {
  return isCodexModelSelectionError(cause)
    ? new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation,
        issue: cause.issue,
        failureClass: "invalid-request",
        cause,
      })
    : undefined;
}

export function toStartSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterValidationError | ProviderAdapterProcessError {
  return (
    toModelSelectionError("startSession", cause) ??
    new ProviderAdapterProcessError({
      provider: PROVIDER,
      threadId,
      detail: toMessage(cause, "Failed to start Codex adapter session."),
      cause,
    })
  );
}

export function toRequestError(
  threadId: ThreadId,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  const modelSelectionError = toModelSelectionError(method, cause);
  if (modelSelectionError) {
    return modelSelectionError;
  }
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    ...(cause instanceof CodexRpcError && cause.delivery === "possibly-applied"
      ? { failureClass: "unsafe-to-replay" as const }
      : {}),
    cause,
  });
}

export const makeResolveAttachment = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly attachmentsDir: string;
}) =>
  Effect.fn("resolveAttachment")(function* (
    turnInput: ProviderSendTurnInput,
    attachment: NonNullable<ProviderSendTurnInput["attachments"]>[number],
  ) {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* toRequestError(
        turnInput.threadId,
        "turn/start",
        new Error(`Invalid attachment id '${attachment.id}'.`),
      );
    }
    const bytes = yield* input.fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: toMessage(cause, "Failed to read attachment file."),
            cause,
          }),
      ),
    );
    if (attachment.type === "file") {
      return {
        type: "file" as const,
        url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
      };
    }
    return {
      type: "image" as const,
      url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
    };
  });
