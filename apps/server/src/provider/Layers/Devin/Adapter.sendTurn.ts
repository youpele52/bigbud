import { TurnId, type ProviderRuntimeEvent, type ThreadId } from "@bigbud/contracts";
import { Effect, type FileSystem } from "effect";
import type { ContentBlock } from "effect-acp/schema";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../../Errors.ts";
import { type DevinAdapterShape } from "../../Services/Devin/Adapter.ts";
import {
  type DevinEventStamp,
  type DevinSessionContext,
  mapAcpToAdapterError,
  PROVIDER,
  applyRequestedSessionConfiguration,
  resolveAttachmentPath,
  resolveDevinAcpBaseModelId,
} from "./Adapter.helpers.ts";

interface SendTurnDeps {
  readonly fileSystem: FileSystem.FileSystem;
  readonly attachmentsDir: string;
  readonly nowIso: Effect.Effect<string>;
  readonly makeEventStamp: () => Effect.Effect<DevinEventStamp>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly requireSession: (
    threadId: ThreadId,
  ) => Effect.Effect<DevinSessionContext, ProviderAdapterSessionNotFoundError>;
}

export function makeSendTurnEffect(
  deps: SendTurnDeps,
  input: Parameters<DevinAdapterShape["sendTurn"]>[0],
) {
  return Effect.gen(function* () {
    const ctx = yield* deps.requireSession(input.threadId);
    const turnId = TurnId.makeUnsafe(crypto.randomUUID());
    const turnModelSelection =
      input.modelSelection?.provider === "devin" ? input.modelSelection : undefined;
    const model = turnModelSelection?.model ?? ctx.session.model;
    const resolvedModel = resolveDevinAcpBaseModelId(model);

    yield* applyRequestedSessionConfiguration({
      runtime: ctx.acp,
      runtimeMode: ctx.session.runtimeMode,
      interactionMode: input.interactionMode,
      modelSelection:
        model === undefined
          ? undefined
          : {
              model,
              options: turnModelSelection?.options,
            },
      mapError: ({ cause, method }) =>
        mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
    });

    ctx.activeTurnId = turnId;
    ctx.lastPlanFingerprint = undefined;
    ctx.session = {
      ...ctx.session,
      activeTurnId: turnId,
      updatedAt: yield* deps.nowIso,
    };

    yield* deps.offerRuntimeEvent({
      type: "turn.started",
      ...(yield* deps.makeEventStamp()),
      provider: PROVIDER,
      threadId: input.threadId,
      turnId,
      payload: { model: resolvedModel },
    });

    const promptParts: Array<ContentBlock> = [];
    if (input.input?.trim()) {
      promptParts.push({ type: "text", text: input.input.trim() });
    }
    if (input.attachments && input.attachments.length > 0) {
      for (const attachment of input.attachments) {
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: deps.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/prompt",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const bytes = yield* deps.fileSystem.readFile(attachmentPath).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: cause.message,
                cause,
              }),
          ),
        );
        promptParts.push({
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: attachment.mimeType,
        });
      }
    }

    if (promptParts.length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Turn requires non-empty text or attachments.",
      });
    }

    const result = yield* ctx.acp
      .prompt({ prompt: promptParts })
      .pipe(
        Effect.mapError((error) =>
          mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
        ),
      );

    ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
    ctx.session = {
      ...ctx.session,
      activeTurnId: turnId,
      updatedAt: yield* deps.nowIso,
      model: resolvedModel,
    };

    yield* deps.offerRuntimeEvent({
      type: "turn.completed",
      ...(yield* deps.makeEventStamp()),
      provider: PROVIDER,
      threadId: input.threadId,
      turnId,
      payload: {
        state: result.stopReason === "cancelled" ? "cancelled" : "completed",
        stopReason: result.stopReason ?? null,
      },
    });

    return {
      threadId: input.threadId,
      turnId,
      resumeCursor: ctx.session.resumeCursor,
    };
  });
}
