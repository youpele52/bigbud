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

import {
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderTurnStartResult,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import {
  CopilotClient,
  type CopilotClientOptions,
  type MessageOptions,
  type SessionConfig,
  type SessionEvent,
} from "@github/copilot-sdk";
import { Effect } from "effect";

import { resolveAttachmentPath } from "../../attachments/attachmentStore.ts";
import {
  appendAttachedFileContents,
  extractPromptTextFromFile,
} from "../../attachments/documentText.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import {
  PROVIDER,
  DEFAULT_BINARY_PATH,
  type ActiveCopilotSession,
  type CopilotAdapterLiveOptions,
  type PendingApprovalRequest,
  type PendingUserInputRequest,
  buildThreadSnapshot,
  isSessionNotFoundError,
  makeNodeWrapperCliPath,
  toMessage,
} from "./CopilotAdapter.types.ts";

/** Deps threaded into session lifecycle operations. */
export interface SessionOpsDeps {
  readonly sessions: Map<ThreadId, ActiveCopilotSession>;
  readonly serverConfig: { readonly attachmentsDir: string };
  readonly serverSettings: {
    readonly getSettings: Effect.Effect<
      {
        readonly providers: {
          readonly copilot: { readonly binaryPath: string };
        };
      },
      Error
    >;
  };
  readonly options: CopilotAdapterLiveOptions | undefined;
  readonly emit: (events: ReadonlyArray<ProviderRuntimeEvent>) => Effect.Effect<void>;
  // biome-ignore lint/suspicious/noExplicitAny: wide type used intentionally to avoid generic function assignment errors
  readonly makeSyntheticEvent: (
    threadId: ThreadId,
    type: string,
    payload: any,
    extra?: { turnId?: TurnId; itemId?: string; requestId?: string },
  ) => Effect.Effect<ProviderRuntimeEvent>;
  readonly buildSessionConfig: (
    input: {
      threadId: ThreadId;
      runtimeMode: ProviderSession["runtimeMode"];
      cwd?: string;
      modelSelection?: ProviderSendTurnInput["modelSelection"] | ProviderSession["resumeCursor"];
    },
    pendingApprovals: Map<string, PendingApprovalRequest>,
    pendingUserInputs: Map<string, PendingUserInputRequest>,
    activeTurnId: () => TurnId | undefined,
    stoppedRef: { stopped: boolean },
  ) => SessionConfig;
  readonly handleEvent: (session: ActiveCopilotSession, event: SessionEvent) => Effect.Effect<void>;
  readonly requireSession: (
    threadId: ThreadId,
  ) => Effect.Effect<ActiveCopilotSession, ProviderAdapterSessionNotFoundError>;
}

export const makeStartSession =
  (deps: SessionOpsDeps): CopilotAdapterShape["startSession"] =>
  (input) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const existing = deps.sessions.get(input.threadId);
      if (existing) {
        return {
          provider: PROVIDER,
          status: existing.activeTurnId ? "running" : "ready",
          runtimeMode: existing.runtimeMode,
          threadId: input.threadId,
          ...(existing.cwd ? { cwd: existing.cwd } : {}),
          ...(existing.model ? { model: existing.model } : {}),
          resumeCursor: { sessionId: existing.session.sessionId },
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
          ...(existing.lastError ? { lastError: existing.lastError } : {}),
        } satisfies ProviderSession;
      }

      const copilotSettings = yield* deps.serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.copilot),
        Effect.orDie,
      );
      const useCustomBinary = copilotSettings.binaryPath !== DEFAULT_BINARY_PATH;
      // When running in Electron, use a shell wrapper as cliPath so the copilot
      // CLI is spawned via the real `node` binary rather than the Electron binary.
      // See makeNodeWrapperCliPath() for full explanation.
      const resolvedCliPath = useCustomBinary
        ? copilotSettings.binaryPath
        : makeNodeWrapperCliPath();
      const clientOptions: CopilotClientOptions = {
        ...(resolvedCliPath !== undefined ? { cliPath: resolvedCliPath } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        logLevel: "error",
      };
      const client =
        deps.options?.clientFactory?.(clientOptions) ?? new CopilotClient(clientOptions);
      const pendingApprovals = new Map<string, PendingApprovalRequest>();
      const pendingUserInputs = new Map<string, PendingUserInputRequest>();
      let activeTurn: TurnId | undefined;
      const stoppedRef = { stopped: false };
      const sessionConfig = deps.buildSessionConfig(
        {
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        },
        pendingApprovals,
        pendingUserInputs,
        () => activeTurn,
        stoppedRef,
      );

      const session = yield* Effect.tryPromise({
        try: () => {
          const sessionId =
            typeof input.resumeCursor === "object" &&
            input.resumeCursor !== null &&
            "sessionId" in input.resumeCursor &&
            typeof input.resumeCursor.sessionId === "string"
              ? input.resumeCursor.sessionId
              : undefined;
          return sessionId
            ? client.resumeSession(sessionId, sessionConfig)
            : client.createSession(sessionConfig);
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to start GitHub Copilot session."),
            cause,
          }),
      });

      const createdAt = new Date().toISOString();
      const record: ActiveCopilotSession = {
        client,
        session,
        threadId: input.threadId,
        createdAt,
        runtimeMode: input.runtimeMode,
        pendingApprovals,
        pendingUserInputs,
        turns: [],
        renewSession: () => client.createSession(sessionConfig),
        unsubscribe: () => {},
        cwd: input.cwd,
        model:
          input.modelSelection?.provider === "copilot" ? input.modelSelection.model : undefined,
        updatedAt: createdAt,
        lastError: undefined,
        activeTurnId: undefined,
        activeMessageId: undefined,
        lastUsage: undefined,
        get stopped() {
          return stoppedRef.stopped;
        },
        set stopped(value: boolean) {
          stoppedRef.stopped = value;
        },
      };

      record.unsubscribe = session.on((event) => {
        activeTurn =
          event.type === "assistant.turn_start" ? TurnId.makeUnsafe(event.data.turnId) : activeTurn;
        void deps
          .handleEvent(record, event)
          .pipe(Effect.runPromise)
          .catch(() => undefined);
        activeTurn = record.activeTurnId;
      });

      deps.sessions.set(input.threadId, record);

      yield* deps.emit([
        yield* deps.makeSyntheticEvent(
          input.threadId,
          "session.started",
          input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
        ),
        yield* deps.makeSyntheticEvent(input.threadId, "thread.started", {
          providerThreadId: session.sessionId,
        }),
        yield* deps.makeSyntheticEvent(input.threadId, "session.state.changed", {
          state: "ready",
          reason: "session.started",
        }),
      ]);

      return {
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(record.model ? { model: record.model } : {}),
        resumeCursor: { sessionId: session.sessionId },
        createdAt,
        updatedAt: createdAt,
      } satisfies ProviderSession;
    });

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
