/**
 * CopilotAdapter.session — session lifecycle operations.
 *
 * Contains `makeStartSession`, `makeSendTurn`, `makeInterruptTurn`,
 * `makeStopSessionRecord`, `makeStopSession`, `makeStopAll`,
 * `makeListSessions`, `makeHasSession`, `makeReadThread`, and
 * `makeRollbackThread` — extracted from the main adapter factory.
 *
 * @module CopilotAdapter.session
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { type ProviderSession, type ProviderTurnStartResult, TurnId } from "@bigbud/contracts";
import { type MessageOptions } from "@github/copilot-sdk";
import { Effect } from "effect";

import { resolveAttachmentPath } from "../../../attachments/attachmentStore.ts";
import {
  appendAttachedFileContents,
  extractPromptTextFromFile,
} from "../../../attachments/documentText.ts";
import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../../Errors.ts";
import { type CopilotAdapterShape } from "../../Services/Copilot/Adapter.ts";
import {
  PROVIDER,
  type ActiveCopilotSession,
  buildThreadSnapshot,
  isSessionNotFoundError,
  toMessage,
} from "./Adapter.types.ts";
export { makeStartSession } from "./Adapter.session.start.ts";
export type { SessionOpsDeps } from "./Adapter.session.start.ts";
import { type SessionOpsDeps } from "./Adapter.session.start.ts";

export const makeSendTurn =
  (deps: SessionOpsDeps): CopilotAdapterShape["sendTurn"] =>
  (input) =>
    Effect.gen(function* () {
      const record = yield* deps.requireSession(input.threadId);
      const extractedTextBlocks: Array<{ readonly fileName: string; readonly text: string }> = [];
      const attachments: MessageOptions["attachments"] = yield* Effect.forEach(
        input.attachments ?? [],
        (attachment) =>
          Effect.gen(function* () {
            const filePath = resolveAttachmentPath({
              attachmentsDir: deps.serverConfig.attachmentsDir,
              attachment,
            });
            if (!filePath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.send",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            if (attachment.type === "file") {
              const extractedText = yield* Effect.tryPromise({
                try: () =>
                  extractPromptTextFromFile({
                    filePath,
                    mimeType: attachment.mimeType,
                    fileName: attachment.name,
                  }),
                catch: (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session.send",
                    detail: `Failed to extract text from attachment '${attachment.name}'.`,
                    cause,
                  }),
              });
              if (extractedText !== null) {
                extractedTextBlocks.push({ fileName: attachment.name, text: extractedText });
              }
            }
            const bytes = yield* Effect.tryPromise({
              try: () => readFile(filePath),
              catch: (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session.send",
                  detail: `Failed to read attachment '${attachment.name}'.`,
                  cause,
                }),
            });
            return {
              type: "blob" as const,
              data: bytes.toString("base64"),
              mimeType: attachment.mimeType,
              displayName: attachment.name,
            };
          }),
      );

      const copilotModelSelection =
        input.modelSelection?.provider === "copilot" ? input.modelSelection : undefined;

      if (copilotModelSelection) {
        record.model = copilotModelSelection.model;

        yield* Effect.tryPromise({
          try: async () => {
            try {
              await record.session.setModel(
                copilotModelSelection.model,
                copilotModelSelection.options?.reasoningEffort
                  ? { reasoningEffort: copilotModelSelection.options.reasoningEffort }
                  : undefined,
              );
            } catch (firstError) {
              if (isSessionNotFoundError(firstError)) {
                const freshSession = await record.renewSession();
                record.session = freshSession;
                await record.session.setModel(
                  copilotModelSelection.model,
                  copilotModelSelection.options?.reasoningEffort
                    ? { reasoningEffort: copilotModelSelection.options.reasoningEffort }
                    : undefined,
                );
              } else {
                throw firstError;
              }
            }
          },
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.setModel",
              detail: toMessage(cause, "Failed to apply GitHub Copilot model selection."),
              cause,
            }),
        });
      }

      const turnId = TurnId.makeUnsafe(`copilot-turn-${randomUUID()}`);
      record.activeTurnId = turnId;
      record.updatedAt = new Date().toISOString();

      const sendPayload: Parameters<typeof record.session.send>[0] = {
        prompt: appendAttachedFileContents(input.input ?? "", extractedTextBlocks),
        ...(attachments.length > 0 ? { attachments } : {}),
        mode: "immediate",
      };

      yield* Effect.tryPromise({
        try: async () => {
          try {
            await record.session.send(sendPayload);
          } catch (firstError) {
            if (isSessionNotFoundError(firstError)) {
              const freshSession = await record.renewSession();
              record.session = freshSession;
              await record.session.send(sendPayload);
            } else {
              throw firstError;
            }
          }
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.send",
            detail: toMessage(cause, "Failed to send GitHub Copilot turn."),
            cause,
          }),
      });

      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: { sessionId: record.session.sessionId },
      } satisfies ProviderTurnStartResult;
    });

export const makeInterruptTurn =
  (deps: SessionOpsDeps): CopilotAdapterShape["interruptTurn"] =>
  (threadId) =>
    Effect.gen(function* () {
      const record = yield* deps.requireSession(threadId);
      yield* Effect.tryPromise({
        try: () => record.session.abort(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.abort",
            detail: toMessage(cause, "Failed to interrupt GitHub Copilot turn."),
            cause,
          }),
      });
    });

/** Disconnect and clean up a single session record. */
export const stopSessionRecord = (
  record: ActiveCopilotSession,
): Effect.Effect<void, ProviderAdapterRequestError> =>
  Effect.tryPromise({
    try: async () => {
      record.stopped = true;
      record.unsubscribe();
      for (const pending of record.pendingApprovals.values()) {
        pending.resolve({ kind: "reject" });
      }
      for (const pending of record.pendingUserInputs.values()) {
        pending.resolve({ answer: "", wasFreeform: true });
      }
      record.pendingApprovals.clear();
      record.pendingUserInputs.clear();
      await record.session.disconnect();
      await record.client.stop();
      await record.cleanupRemoteWorkspaceBridge?.();
    },
    catch: (cause) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "session.stop",
        detail: toMessage(cause, "Failed to stop GitHub Copilot session."),
        cause,
      }),
  });

export const makeStopSession =
  (deps: SessionOpsDeps): CopilotAdapterShape["stopSession"] =>
  (threadId) =>
    Effect.gen(function* () {
      const record = yield* deps.requireSession(threadId);
      yield* stopSessionRecord(record);
    });

export const makeListSessions =
  (deps: SessionOpsDeps): CopilotAdapterShape["listSessions"] =>
  () =>
    Effect.succeed(
      Array.from(deps.sessions.values()).map((record) => {
        return Object.assign(
          {
            provider: PROVIDER,
            status: record.activeTurnId ? ("running" as const) : ("ready" as const),
            runtimeMode: record.runtimeMode,
            threadId: record.threadId,
            ...(record.providerRuntimeExecutionTargetId
              ? { providerRuntimeExecutionTargetId: record.providerRuntimeExecutionTargetId }
              : {}),
            ...(record.workspaceExecutionTargetId
              ? { workspaceExecutionTargetId: record.workspaceExecutionTargetId }
              : {}),
            resumeCursor: { sessionId: record.session.sessionId },
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          },
          record.cwd ? { cwd: record.cwd } : undefined,
          record.model ? { model: record.model } : undefined,
          record.activeTurnId ? { activeTurnId: record.activeTurnId } : undefined,
          record.lastError ? { lastError: record.lastError } : undefined,
        ) satisfies ProviderSession;
      }),
    );

export const makeHasSession =
  (deps: SessionOpsDeps): CopilotAdapterShape["hasSession"] =>
  (threadId) =>
    Effect.succeed(deps.sessions.has(threadId));

export const makeReadThread =
  (deps: SessionOpsDeps): CopilotAdapterShape["readThread"] =>
  (threadId) =>
    Effect.gen(function* () {
      const record = yield* deps.requireSession(threadId);
      return buildThreadSnapshot(threadId, record.turns);
    });

export const makeRollbackThread =
  (): CopilotAdapterShape["rollbackThread"] => (threadId, _numTurns) =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "rollbackThread",
        issue: "GitHub Copilot sessions do not support rolling back conversation state.",
      }),
    ).pipe(Effect.annotateLogs({ threadId }));

export const makeStopAll =
  (deps: SessionOpsDeps): CopilotAdapterShape["stopAll"] =>
  () =>
    Effect.forEach(Array.from(deps.sessions.values()), stopSessionRecord, {
      concurrency: "unbounded",
    }).pipe(Effect.asVoid);
