import { type ProviderRuntimeEvent, type ThreadId } from "@bigbud/contracts";
import { FULL_ACCESS_AUTO_APPROVE_AFTER_MS } from "@bigbud/shared/approvals";
import { Effect, Exit, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { type CursorAdapterShape } from "../../Services/Cursor/Adapter.ts";
import {
  type CursorAdapterLiveOptions,
  type CursorEventStamp,
  type CursorSessionContext,
  type PendingApproval,
  type PendingUserInput,
  ApprovalRequestId,
  RuntimeRequestId,
  Deferred,
  ProviderAdapterValidationError,
  ProviderAdapterProcessError,
  acpPermissionOutcome,
  mapAcpToAdapterError,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  nodePath,
  parsePermissionRequest,
  makeAcpNativeLoggers,
  makeCursorAcpRuntime,
  CursorAskQuestionRequest,
  CursorCreatePlanRequest,
  CursorUpdateTodosRequest,
  extractAskQuestions,
  extractPlanMarkdown,
  extractTodosAsPlan,
  CURSOR_RESUME_VERSION,
  PROVIDER,
  applyRequestedSessionConfiguration,
  parseCursorResume,
  scheduleFullAccessPermissionAutoApproval,
  selectAutoApprovedPermissionOption,
} from "./Adapter.helpers.ts";
import { emitPlanUpdate, forkNotificationFiber, logNative } from "./Adapter.startSession.events.ts";

interface StartSessionDeps {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly nativeEventLogger: CursorAdapterLiveOptions["nativeEventLogger"] | undefined;
  readonly serverConfig: {
    readonly stateDir: string;
    readonly host: string | undefined;
    readonly port: number;
  };
  readonly sessions: Map<ThreadId, CursorSessionContext>;
  readonly notificationScope: Scope.Scope;
  readonly stopSessionInternal: (ctx: CursorSessionContext) => Effect.Effect<void>;
  readonly getCursorSettings: (
    threadId: ThreadId,
  ) => Effect.Effect<
    Parameters<typeof makeCursorAcpRuntime>[0]["cursorSettings"],
    ProviderAdapterProcessError
  >;
  readonly makeEventStamp: () => Effect.Effect<CursorEventStamp>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly nowIso: Effect.Effect<string>;
}

export function makeStartSessionEffect(
  deps: StartSessionDeps,
  input: Parameters<CursorAdapterShape["startSession"]>[0],
) {
  return Effect.gen(function* () {
    if (input.provider !== undefined && input.provider !== PROVIDER) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
      });
    }
    if (!input.cwd?.trim()) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: "cwd is required and must be non-empty.",
      });
    }

    const cwd = nodePath.resolve(input.cwd.trim());
    const cursorModelSelection =
      input.modelSelection?.provider === "cursor" ? input.modelSelection : undefined;
    const existing = deps.sessions.get(input.threadId);
    if (existing && !existing.stopped) {
      yield* deps.stopSessionInternal(existing);
    }

    const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
    const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
    const sessionScope = yield* Scope.make("sequential");
    let sessionScopeTransferred = false;
    yield* Effect.addFinalizer(() =>
      sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
    );
    let ctx!: CursorSessionContext;

    const acpNativeLoggers = makeAcpNativeLoggers({
      nativeEventLogger: deps.nativeEventLogger,
      provider: PROVIDER,
      threadId: input.threadId,
    });
    const cursorSettings = yield* deps.getCursorSettings(input.threadId);
    const resumeSessionId = parseCursorResume(input.resumeCursor)?.sessionId;
    const acp = yield* makeCursorAcpRuntime({
      cursorSettings,
      childProcessSpawner: deps.childProcessSpawner,
      cwd,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      clientInfo: { name: "bigbud", version: "0.0.0" },
      ...acpNativeLoggers,
    }).pipe(
      Effect.provideService(Scope.Scope, sessionScope),
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: cause.message,
            cause,
          }),
      ),
    );

    const started = yield* Effect.gen(function* () {
      yield* acp.handleExtRequest("cursor/ask_question", CursorAskQuestionRequest, (params) =>
        Effect.gen(function* () {
          yield* logNative(deps, input.threadId, "cursor/ask_question", params);
          const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
          const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
          const answers =
            yield* Deferred.make<import("@bigbud/contracts").ProviderUserInputAnswers>();
          pendingUserInputs.set(requestId, { answers });
          yield* deps.offerRuntimeEvent({
            type: "user-input.requested",
            ...(yield* deps.makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId: ctx?.activeTurnId,
            requestId: runtimeRequestId,
            payload: { questions: extractAskQuestions(params) },
            raw: {
              source: "acp.cursor.extension",
              method: "cursor/ask_question",
              payload: params,
            },
          });
          const resolved = yield* Deferred.await(answers);
          pendingUserInputs.delete(requestId);
          yield* deps.offerRuntimeEvent({
            type: "user-input.resolved",
            ...(yield* deps.makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId: ctx?.activeTurnId,
            requestId: runtimeRequestId,
            payload: { answers: resolved },
          });
          return { answers: resolved };
        }),
      );
      yield* acp.handleExtRequest("cursor/create_plan", CursorCreatePlanRequest, (params) =>
        Effect.gen(function* () {
          yield* logNative(deps, input.threadId, "cursor/create_plan", params);
          yield* deps.offerRuntimeEvent({
            type: "turn.proposed.completed",
            ...(yield* deps.makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId: ctx?.activeTurnId,
            payload: { planMarkdown: extractPlanMarkdown(params) },
            raw: {
              source: "acp.cursor.extension",
              method: "cursor/create_plan",
              payload: params,
            },
          });
          return { accepted: true } as const;
        }),
      );
      yield* acp.handleExtNotification("cursor/update_todos", CursorUpdateTodosRequest, (params) =>
        Effect.gen(function* () {
          yield* logNative(deps, input.threadId, "cursor/update_todos", params);
          if (ctx) {
            yield* emitPlanUpdate(
              deps,
              ctx,
              extractTodosAsPlan(params),
              params,
              "acp.cursor.extension",
              "cursor/update_todos",
            );
          }
        }),
      );
      yield* acp.handleRequestPermission((params) =>
        Effect.gen(function* () {
          yield* logNative(deps, input.threadId, "session/request_permission", params);
          if (input.runtimeMode === "full-access") {
            const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
            if (autoApprovedOptionId !== undefined) {
              return {
                outcome: {
                  outcome: "selected" as const,
                  optionId: autoApprovedOptionId,
                },
              };
            }
          }
          const permissionRequest = parsePermissionRequest(params);
          const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
          const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
          const decision =
            yield* Deferred.make<import("@bigbud/contracts").ProviderApprovalDecision>();
          pendingApprovals.set(requestId, { decision, kind: permissionRequest.kind });
          const autoApproveAfterMs =
            input.runtimeMode === "full-access" ? FULL_ACCESS_AUTO_APPROVE_AFTER_MS : undefined;
          yield* deps.offerRuntimeEvent(
            makeAcpRequestOpenedEvent({
              stamp: yield* deps.makeEventStamp(),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: ctx?.activeTurnId,
              requestId: runtimeRequestId,
              permissionRequest,
              detail: permissionRequest.detail ?? JSON.stringify(params).slice(0, 2000),
              args: params,
              source: "acp.jsonrpc",
              method: "session/request_permission",
              rawPayload: params,
              ...(autoApproveAfterMs !== undefined ? { autoApproveAfterMs } : {}),
            }),
          );
          if (autoApproveAfterMs !== undefined) {
            scheduleFullAccessPermissionAutoApproval({
              requestId,
              pendingApprovals,
              stopped: () => ctx?.stopped ?? false,
              decision,
            });
          }
          const resolved = yield* Deferred.await(decision);
          pendingApprovals.delete(requestId);
          yield* deps.offerRuntimeEvent(
            makeAcpRequestResolvedEvent({
              stamp: yield* deps.makeEventStamp(),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: ctx?.activeTurnId,
              requestId: runtimeRequestId,
              permissionRequest,
              decision: resolved,
            }),
          );
          return {
            outcome:
              resolved === "cancel"
                ? ({ outcome: "cancelled" } as const)
                : {
                    outcome: "selected" as const,
                    optionId: acpPermissionOutcome(resolved),
                  },
          };
        }),
      );
      return yield* acp.start();
    }).pipe(
      Effect.mapError((error) =>
        mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
      ),
    );

    yield* applyRequestedSessionConfiguration({
      runtime: acp,
      runtimeMode: input.runtimeMode,
      interactionMode: undefined,
      modelSelection: cursorModelSelection,
      mapError: ({ cause, method }) =>
        mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
    });

    const now = yield* deps.nowIso;
    const session = {
      provider: PROVIDER,
      status: "ready",
      runtimeMode: input.runtimeMode,
      cwd,
      model: cursorModelSelection?.model,
      threadId: input.threadId,
      resumeCursor: {
        schemaVersion: CURSOR_RESUME_VERSION,
        sessionId: started.sessionId,
      },
      createdAt: now,
      updatedAt: now,
    } satisfies import("@bigbud/contracts").ProviderSession;

    ctx = {
      threadId: input.threadId,
      session,
      scope: sessionScope,
      acp,
      notificationFiber: undefined,
      pendingApprovals,
      pendingUserInputs,
      turns: [],
      lastPlanFingerprint: undefined,
      activeTurnId: undefined,
      stopped: false,
    };

    ctx.notificationFiber = yield* forkNotificationFiber(deps, ctx, deps.notificationScope);
    deps.sessions.set(input.threadId, ctx);
    sessionScopeTransferred = true;

    yield* deps.offerRuntimeEvent({
      type: "session.started",
      ...(yield* deps.makeEventStamp()),
      provider: PROVIDER,
      threadId: input.threadId,
      payload: { resume: started.initializeResult },
    });
    yield* deps.offerRuntimeEvent({
      type: "session.state.changed",
      ...(yield* deps.makeEventStamp()),
      provider: PROVIDER,
      threadId: input.threadId,
      payload: { state: "ready", reason: "Cursor ACP session ready" },
    });
    yield* deps.offerRuntimeEvent({
      type: "thread.started",
      ...(yield* deps.makeEventStamp()),
      provider: PROVIDER,
      threadId: input.threadId,
      payload: { providerThreadId: started.sessionId },
    });

    return session;
  });
}
