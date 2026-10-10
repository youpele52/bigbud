import { TurnId, type ProviderRuntimeEvent, type ThreadId } from "@bigbud/contracts";
import { Effect, type FileSystem } from "effect";
import type { ContentBlock } from "effect-acp/schema";
import {
  canReadManagedProviderPaths,
  prepareManagedAttachmentContext,
} from "../../../attachments/providerAttachments.managed.ts";

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

    const prepared = yield* Effect.tryPromise({
      try: () =>
        prepareManagedAttachmentContext(
          input.input ?? "",
          input.attachments ?? [],
          deps.attachmentsDir,
          canReadManagedProviderPaths(ctx.session),
        ),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/prompt",
          detail: cause instanceof Error ? cause.message : "Failed to prepare attachments.",
          cause,
        }),
    });
    yield* applyRequestedSessionConfiguration({
      runtime: ctx.acp,
      runtimeMode: ctx.session.runtimeMode,
      interactionMode: input.interactionMode,
      modelSelection:
        model === undefined ? undefined : { model, options: turnModelSelection?.options },
      mapError: ({ cause, method }) =>
        mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
    });
    const promptParts: Array<ContentBlock> = [];
    if (prepared.text.trim()) {
      promptParts.push({ type: "text", text: prepared.text.trim() });
    }
    if (prepared.attachments.length > 0) {
      for (const { attachment, bytes } of prepared.attachments) {
        if (attachment.type !== "image") continue;
        promptParts.push({
          type: "image",
          data: bytes.toString("base64"),
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

    ctx.activeTurnId = turnId;
    ctx.lastPlanFingerprint = undefined;
    ctx.session = {
      ...ctx.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt: yield* deps.nowIso,
    };

    yield* deps.offerRuntimeEvent({
      type: "turn.started",
      ...(yield* deps.makeEventStamp()),
      sessionEpoch: ctx.sessionEpoch,
      provider: PROVIDER,
      threadId: input.threadId,
      turnId,
      payload: { model: resolvedModel },
    });

    const result = yield* ctx.acp.prompt({ prompt: promptParts }).pipe(
      Effect.mapError((error) =>
        mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
      ),
      Effect.tapError(() => Effect.sync(() => settleIdleDevinTurn(ctx))),
    );

    ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
    settleIdleDevinTurn(ctx, {
      updatedAt: yield* deps.nowIso,
      model: resolvedModel,
    });

    yield* deps.offerRuntimeEvent({
      type: "turn.completed",
      ...(yield* deps.makeEventStamp()),
      sessionEpoch: ctx.sessionEpoch,
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

function settleIdleDevinTurn(
  ctx: DevinSessionContext,
  next?: { readonly updatedAt?: string; readonly model?: string },
) {
  ctx.activeTurnId = undefined;
  ctx.session = {
    ...ctx.session,
    status: "ready",
    activeTurnId: undefined,
    ...(next?.updatedAt !== undefined ? { updatedAt: next.updatedAt } : {}),
    ...(next?.model !== undefined ? { model: next.model } : {}),
  };
}
