/**
 * Session lifecycle for the Codex provider adapter.
 *
 * Implements startSession, sendTurn, interruptTurn, readThread, rollbackThread,
 * respondToRequest, respondToUserInput, stopSession, and related helpers.
 *
 * @module CodexAdapter.session
 */
import {
  LOCAL_EXECUTION_TARGET_ID,
  type ProviderEvent,
  type ProviderSendTurnInput,
  ThreadId,
} from "@bigbud/contracts";
import { Effect, FileSystem, Queue, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../../Errors.ts";
import type { CodexAdapterShape } from "../../Services/Codex/Adapter.ts";
import {
  CodexAppServerManager,
  type CodexAppServerStartSessionInput,
} from "../../../codex/codexAppServerManager.ts";
import { createCodexRemoteWorkspaceBridge } from "../../../codex/codexRemoteWorkspaceBridge.ts";
import { resolveAttachmentPath } from "../../../attachments/attachmentStore.ts";
import {
  appendAttachedFileContents,
  extractPromptTextFromFile,
} from "../../../attachments/documentText.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { isLocalProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import { isRemoteWorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "../EventNdjsonLogger.ts";
import { getProviderCapabilities } from "../../providerCapabilities.ts";
import { resolveProviderExecutionContext } from "../../providerExecutionContext.ts";
import { mapToRuntimeEvents } from "./Adapter.stream.ts";
import { PROVIDER, toMessage, type CodexAdapterLiveOptions } from "./Adapter.types.ts";

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("unknown provider session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("session is closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

/** Builds the full Codex adapter shape given a manager and supporting services. */
export const makeCodexAdapter = Effect.fn("makeCodexAdapter")(function* (
  options?: CodexAdapterLiveOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* Effect.service(ServerConfig);
  const nativeEventLogger: EventNdjsonLogger | undefined =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);

  const acquireManager = Effect.fn("acquireManager")(function* () {
    if (options?.manager) {
      return options.manager;
    }
    const services = yield* Effect.services<never>();
    return options?.makeManager?.(services) ?? new CodexAppServerManager(services);
  });

  const manager = yield* Effect.acquireRelease(acquireManager(), (m) =>
    Effect.sync(() => {
      try {
        m.stopAll();
      } catch {
        // Finalizers should never fail and block shutdown.
      }
    }),
  );
  const serverSettingsService = yield* ServerSettingsService;

  const startSession: CodexAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const codexSettings = yield* serverSettingsService.getSettings.pipe(
        Effect.map((settings) => settings.providers.codex),
        Effect.mapError(
          (error) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: error.message,
              cause: error,
            }),
        ),
      );
      const binaryPath = codexSettings.binaryPath;
      const homePath = codexSettings.homePath;
      const executionContext = resolveProviderExecutionContext({
        providerRuntimeExecutionTargetId: input.providerRuntimeExecutionTargetId,
        workspaceExecutionTargetId: input.workspaceExecutionTargetId,
        executionTargetId: input.executionTargetId,
        cwd: input.cwd,
        defaultProviderRuntimeExecutionTargetId: getProviderCapabilities(PROVIDER)
          .supportsLocalRuntimeRemoteWorkspace
          ? LOCAL_EXECUTION_TARGET_ID
          : undefined,
        useLegacyExecutionTargetForProviderRuntime: false,
      });
      const remoteWorkspaceBridge =
        isLocalProviderRuntimeTarget(executionContext.providerRuntimeTarget) &&
        isRemoteWorkspaceTarget(executionContext.workspaceTarget)
          ? yield* Effect.tryPromise({
              try: () => createCodexRemoteWorkspaceBridge(executionContext.workspaceTarget),
              catch: (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: toMessage(cause, "Failed to prepare Codex remote workspace bridge."),
                  cause,
                }),
            })
          : undefined;
      const managerInput: CodexAppServerStartSessionInput = {
        threadId: input.threadId,
        provider: "codex",
        providerRuntimeExecutionTargetId:
          executionContext.executionTargets.providerRuntimeExecutionTargetId,
        workspaceExecutionTargetId: executionContext.executionTargets.workspaceExecutionTargetId,
        executionTargetId: executionContext.executionTargets.executionTargetId,
        ...(remoteWorkspaceBridge?.cwd
          ? { cwd: remoteWorkspaceBridge.cwd }
          : input.cwd !== undefined
            ? { cwd: input.cwd }
            : {}),
        ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        runtimeMode: input.runtimeMode,
        binaryPath,
        ...(homePath ? { homePath } : {}),
        ...(remoteWorkspaceBridge?.configArgs
          ? { configArgs: remoteWorkspaceBridge.configArgs }
          : {}),
        ...(remoteWorkspaceBridge?.cleanup
          ? { cleanupRemoteWorkspaceBridge: remoteWorkspaceBridge.cleanup }
          : {}),
        ...(remoteWorkspaceBridge?.promptPrefix
          ? { developerInstructions: remoteWorkspaceBridge.promptPrefix }
          : {}),
        ...(input.modelSelection?.provider === "codex"
          ? { model: input.modelSelection.model }
          : {}),
        ...(input.modelSelection?.provider === "codex" && input.modelSelection.options?.fastMode
          ? { serviceTier: "fast" }
          : {}),
      };

      return yield* Effect.tryPromise({
        try: () => manager.startSession(managerInput),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to start Codex adapter session."),
            cause,
          }),
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            void remoteWorkspaceBridge?.cleanup().catch(() => undefined);
          }),
        ),
      );
    },
  );

  const resolveAttachment = Effect.fn("resolveAttachment")(function* (
    input: ProviderSendTurnInput,
    attachment: NonNullable<ProviderSendTurnInput["attachments"]>[number],
  ) {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* toRequestError(
        input.threadId,
        "turn/start",
        new Error(`Invalid attachment id '${attachment.id}'.`),
      );
    }
    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
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

  const sendTurn: CodexAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const extractedTextBlocks: Array<{ readonly fileName: string; readonly text: string }> = [];
    const codexAttachments = yield* Effect.forEach(
      input.attachments ?? [],
      (attachment) =>
        Effect.gen(function* () {
          if (attachment.type === "file") {
            const sourcePath =
              attachment.sourcePath ??
              resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment });
            if (sourcePath) {
              const extractedText = yield* Effect.tryPromise({
                try: () =>
                  extractPromptTextFromFile({
                    filePath: sourcePath,
                    mimeType: attachment.mimeType,
                    fileName: attachment.name,
                  }),
                catch: (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "turn/start",
                    detail: toMessage(cause, "Failed to extract attachment text."),
                    cause,
                  }),
              });
              if (extractedText !== null) {
                extractedTextBlocks.push({ fileName: attachment.name, text: extractedText });
              }
            }
          }
          return yield* resolveAttachment(input, attachment);
        }),
      { concurrency: 1 },
    );

    return yield* Effect.tryPromise({
      try: () => {
        const managerInput = {
          threadId: input.threadId,
          input: appendAttachedFileContents(input.input ?? "", extractedTextBlocks),
          ...(input.modelSelection?.provider === "codex"
            ? { model: input.modelSelection.model }
            : {}),
          ...(input.modelSelection?.provider === "codex" &&
          input.modelSelection.options?.reasoningEffort !== undefined
            ? { effort: input.modelSelection.options.reasoningEffort }
            : {}),
          ...(input.modelSelection?.provider === "codex" && input.modelSelection.options?.fastMode
            ? { serviceTier: "fast" }
            : {}),
          ...(input.interactionMode !== undefined
            ? { interactionMode: input.interactionMode }
            : {}),
          ...(codexAttachments.length > 0 ? { attachments: codexAttachments } : {}),
        };
        return manager.sendTurn(managerInput);
      },
      catch: (cause) => toRequestError(input.threadId, "turn/start", cause),
    }).pipe(
      Effect.map((result) => ({
        ...result,
        threadId: input.threadId,
      })),
    );
  });

  const interruptTurn: CodexAdapterShape["interruptTurn"] = (threadId, turnId) =>
    Effect.tryPromise({
      try: () => manager.interruptTurn(threadId, turnId),
      catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
    });

  const readThread: CodexAdapterShape["readThread"] = (threadId) =>
    Effect.tryPromise({
      try: () => manager.readThread(threadId),
      catch: (cause) => toRequestError(threadId, "thread/read", cause),
    }).pipe(
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );

  const rollbackThread: CodexAdapterShape["rollbackThread"] = (threadId, numTurns) => {
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        }),
      );
    }

    return Effect.tryPromise({
      try: () => manager.rollbackThread(threadId, numTurns),
      catch: (cause) => toRequestError(threadId, "thread/rollback", cause),
    }).pipe(
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );
  };

  const respondToRequest: CodexAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.tryPromise({
      try: () => manager.respondToRequest(threadId, requestId, decision),
      catch: (cause) => toRequestError(threadId, "item/requestApproval/decision", cause),
    });

  const respondToUserInput: CodexAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.tryPromise({
      try: () => manager.respondToUserInput(threadId, requestId, answers),
      catch: (cause) => toRequestError(threadId, "item/tool/requestUserInput", cause),
    });

  const stopSession: CodexAdapterShape["stopSession"] = (threadId) =>
    Effect.sync(() => {
      manager.stopSession(threadId);
    });

  const listSessions: CodexAdapterShape["listSessions"] = () =>
    Effect.sync(() => manager.listSessions());

  const hasSession: CodexAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => manager.hasSession(threadId));

  const stopAll: CodexAdapterShape["stopAll"] = () =>
    Effect.sync(() => {
      manager.stopAll();
    });

  const runtimeEventQueue =
    yield* Queue.unbounded<import("@bigbud/contracts").ProviderRuntimeEvent>();

  const writeNativeEvent = Effect.fn("writeNativeEvent")(function* (event: ProviderEvent) {
    if (!nativeEventLogger) {
      return;
    }
    yield* nativeEventLogger.write(event, event.threadId);
  });

  const registerListener = Effect.fn("registerListener")(function* () {
    const services = yield* Effect.services<never>();
    const listenerEffect = Effect.fn("listener")(function* (event: ProviderEvent) {
      yield* writeNativeEvent(event);
      const runtimeEvents = mapToRuntimeEvents(event, event.threadId);
      if (runtimeEvents.length === 0) {
        yield* Effect.logDebug("ignoring unhandled Codex provider event", {
          method: event.method,
          threadId: event.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
        });
        return;
      }
      yield* Queue.offerAll(runtimeEventQueue, runtimeEvents);
    });
    const listener = (event: ProviderEvent) =>
      listenerEffect(event).pipe(Effect.runPromiseWith(services));
    manager.on("event", listener);
    return listener;
  });

  const unregisterListener = Effect.fn("unregisterListener")(function* (
    listener: (event: ProviderEvent) => Promise<void>,
  ) {
    yield* Effect.sync(() => {
      manager.off("event", listener);
    });
    yield* Queue.shutdown(runtimeEventQueue);
  });

  yield* Effect.acquireRelease(registerListener(), unregisterListener);

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies CodexAdapterShape;
});
