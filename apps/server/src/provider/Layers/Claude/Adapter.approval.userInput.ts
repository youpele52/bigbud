import type {
  CanUseTool,
  ElicitationRequest,
  ElicitationResult,
  OnElicitation,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type ProviderUserInputAnswers,
  type UserInputQuestion,
} from "@bigbud/contracts";
import { Deferred, Duration, Effect, Ref } from "effect";

import type { ApprovalHandlerDeps } from "./Adapter.approval.ts";
import {
  trimRequestLedger,
  type PendingUserInputLedgerEntry,
  type ResolvedUserInputLedgerEntry,
} from "./Adapter.requestLedger.ts";
import { decodeClaudePermissionCallback } from "./Adapter.sdk.messages.ts";
import { claudeSdkPermissionRuntimeRaw } from "./Adapter.sdk.projections.ts";
import type { ClaudeSessionContext, PendingUserInput } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import { asCanonicalTurnId, asRuntimeRequestId, nativeProviderRefs } from "./Adapter.utils.ts";
import { awaitClaudeCallback } from "./Adapter.approval.wait.ts";
import { cancelAbandonedClaudeRequest } from "./Adapter.approval.lifecycle.ts";
import { resolveClaudeRequest } from "./Adapter.approval.resolve.ts";
import {
  claudeUserInputQuestions,
  elicitationContent,
} from "./Adapter.approval.userInput.utils.ts";

const MCP_ELICITATION_TIMEOUT_MS = 120_000;

export function makeUserInputHandlers(deps: ApprovalHandlerDeps) {
  const {
    makeEventStamp,
    offerRuntimeEvent,
    runFork,
    runPromise,
    contextRef,
    pendingUserInputs,
    requestLedger,
  } = deps;

  const handleAskUserQuestion = Effect.fn("handleAskUserQuestion")(function* (
    context: ClaudeSessionContext,
    toolInput: Record<string, unknown>,
    callbackOptions: Parameters<CanUseTool>[2],
  ) {
    const requestId = ApprovalRequestId.makeUnsafe(callbackOptions.requestId);
    const callback = decodeClaudePermissionCallback(callbackOptions);
    if (!callback) {
      return {
        behavior: "deny",
        message: "Invalid user-input callback correlation.",
      } satisfies PermissionResult;
    }
    if (context.stopped || context.session.status === "closed" || callbackOptions.signal.aborted) {
      return {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult;
    }

    const existingInput = requestLedger.get(requestId);
    if (existingInput?.kind === "user-input" && existingInput.state === "resolved") {
      if (existingInput.result) return existingInput.result;
    }
    if (existingInput?.kind === "user-input" && existingInput.state !== "resolved") {
      yield* awaitClaudeCallback(
        callbackOptions.signal,
        Deferred.await(existingInput.completion),
        undefined,
        runFork,
      );
      if (callbackOptions.signal.aborted || existingInput.cancelled || context.stopped) {
        return {
          behavior: "deny",
          message: "User cancelled tool execution.",
        } satisfies PermissionResult;
      }
      const resolved = requestLedger.get(requestId);
      if (resolved?.kind === "user-input" && resolved.state === "resolved" && resolved.result) {
        return resolved.result;
      }
      return {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult;
    }

    const questions = claudeUserInputQuestions(toolInput);
    const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
    const pendingInput: PendingUserInput = {
      questions,
      answers: answersDeferred,
      cancelled: false,
    };
    const createdAt = new Date().toISOString();
    pendingUserInputs.set(requestId, pendingInput);
    const pendingLedgerEntry: PendingUserInputLedgerEntry = {
      kind: "user-input",
      state: "pending",
      requestId,
      createdAt,
      questions,
      answers: answersDeferred,
      cancelled: false,
      providerRequestId: callback.requestId,
      completion: Deferred.makeUnsafe<void>(),
      ...(callback.agentId ? { providerAgentId: callback.agentId } : {}),
      providerItemId: callback.toolUseId,
    };
    requestLedger.set(requestId, pendingLedgerEntry);
    trimRequestLedger(requestLedger);
    return yield* Effect.gen(function* () {
      const requestedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent(context, {
        type: "user-input.requested",
        eventId: requestedStamp.eventId,
        provider: PROVIDER,
        createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: { questions },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: callback.toolUseId,
          providerRequestId: callback.requestId,
          ...(callback.agentId ? { providerAgentId: callback.agentId } : {}),
        }),
        raw: claudeSdkPermissionRuntimeRaw("canUseTool/AskUserQuestion"),
      });
      const answers = yield* awaitClaudeCallback(
        callbackOptions.signal,
        Deferred.await(answersDeferred),
        {},
        runFork,
        Effect.sync(() => {
          pendingInput.cancelled = true;
          pendingLedgerEntry.cancelled = true;
        }).pipe(Effect.andThen(Deferred.succeed(answersDeferred, {}))),
      );
      const settled = requestLedger.get(requestId);
      if (settled?.kind === "user-input" && settled.state === "resolved" && settled.result) {
        return settled.result;
      }
      let resolvedAt = new Date().toISOString();
      return yield* resolveClaudeRequest(
        context,
        requestId,
        callbackOptions.signal,
        (cancelled) =>
          Effect.gen(function* () {
            const resolvedStamp = yield* makeEventStamp();
            resolvedAt = resolvedStamp.createdAt;
            yield* offerRuntimeEvent(context, {
              type: "user-input.resolved",
              eventId: resolvedStamp.eventId,
              provider: PROVIDER,
              createdAt: resolvedStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              requestId: asRuntimeRequestId(requestId),
              payload:
                cancelled() || pendingInput.cancelled
                  ? { answers: {} }
                  : pendingInput.sensitive
                    ? {
                        answers: Object.fromEntries(
                          Object.keys(answers).map((key) => [key, "[redacted]"]),
                        ),
                      }
                    : { answers },
              providerRefs: nativeProviderRefs(context, {
                providerItemId: callback.toolUseId,
                providerRequestId: callback.requestId,
                ...(callback.agentId ? { providerAgentId: callback.agentId } : {}),
              }),
              raw: claudeSdkPermissionRuntimeRaw("canUseTool/AskUserQuestion/resolved"),
            });
          }),
        (cancelled) => {
          pendingUserInputs.delete(requestId);
          const result: PermissionResult =
            cancelled || pendingInput.cancelled
              ? { behavior: "deny", message: "User cancelled tool execution." }
              : {
                  behavior: "allow",
                  updatedInput: { questions: toolInput.questions, answers },
                };
          const resolvedEntry: ResolvedUserInputLedgerEntry = {
            kind: "user-input",
            state: "resolved",
            requestId,
            createdAt,
            resolvedAt,
            answers: result.behavior === "deny" ? {} : answers,
            result,
            providerRequestId: callback.requestId,
            ...(callback.agentId ? { providerAgentId: callback.agentId } : {}),
            providerItemId: callback.toolUseId,
          };
          return { entry: resolvedEntry, result };
        },
      );
    }).pipe(Effect.ensuring(cancelAbandonedClaudeRequest(context, requestId, deps)));
  });

  const onElicitation: OnElicitation = (
    request: ElicitationRequest,
    options: Parameters<OnElicitation>[1],
  ) =>
    runPromise(
      Effect.gen(function* () {
        const context = yield* Ref.get(contextRef);
        if (
          !context ||
          context.stopped ||
          context.session.status === "closed" ||
          options.signal.aborted
        )
          return { action: "cancel" } satisfies ElicitationResult;
        const requestId = ApprovalRequestId.makeUnsafe(options.requestId);
        const existing = requestLedger.get(requestId);
        if (existing?.kind === "user-input" && existing.state === "resolved") {
          return existing.elicitationResult ?? ({ action: "cancel" } satisfies ElicitationResult);
        }
        if (existing?.kind === "user-input") {
          yield* awaitClaudeCallback(
            options.signal,
            Deferred.await(existing.completion),
            undefined,
            runFork,
          );
          if (options.signal.aborted || context.stopped)
            return { action: "cancel" } satisfies ElicitationResult;
          const resolved = requestLedger.get(requestId);
          if (resolved?.kind === "user-input" && resolved.state === "resolved") {
            return resolved.elicitationResult ?? ({ action: "cancel" } satisfies ElicitationResult);
          }
          return { action: "cancel" } satisfies ElicitationResult;
        }

        const properties =
          request.requestedSchema?.properties &&
          typeof request.requestedSchema.properties === "object"
            ? request.requestedSchema.properties
            : {};
        const questions: Array<UserInputQuestion> = Object.keys(properties)
          .slice(0, 32)
          .map((id) => ({
            id,
            header: id,
            question: id,
            options: [],
            multiSelect: false,
          }));
        const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
        const pending: PendingUserInput = {
          questions,
          answers: answersDeferred,
          cancelled: false,
          sensitive: true,
        };
        const createdAt = new Date().toISOString();
        pendingUserInputs.set(requestId, pending);
        requestLedger.set(requestId, {
          kind: "user-input",
          state: "pending",
          requestId,
          createdAt,
          questions,
          answers: answersDeferred,
          cancelled: false,
          sensitive: true,
          providerRequestId: options.requestId,
          completion: Deferred.makeUnsafe<void>(),
        });
        trimRequestLedger(requestLedger);
        return yield* Effect.gen(function* () {
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "user-input.requested",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            requestId: asRuntimeRequestId(requestId),
            payload: { questions, ...(request.mode ? { mode: request.mode } : {}) },
            providerRefs: nativeProviderRefs(context),
            raw: claudeSdkPermissionRuntimeRaw("onElicitation/request"),
          });
          const waitResult = yield* awaitClaudeCallback(
            options.signal,
            Effect.race(
              Deferred.await(answersDeferred).pipe(Effect.map((answers) => ({ answers }) as const)),
              Effect.sleep(Duration.millis(MCP_ELICITATION_TIMEOUT_MS)).pipe(
                Effect.as({ timedOut: true } as const),
              ),
            ),
            { answers: {} } as
              | { readonly answers: ProviderUserInputAnswers }
              | { readonly timedOut: true },
            runFork,
            Effect.sync(() => {
              pending.cancelled = true;
              const entry = requestLedger.get(requestId);
              if (entry?.kind === "user-input" && entry.state === "pending") entry.cancelled = true;
            }).pipe(Effect.andThen(Deferred.succeed(answersDeferred, {}))),
          );
          const settled = requestLedger.get(requestId);
          if (
            settled?.kind === "user-input" &&
            settled.state === "resolved" &&
            settled.elicitationResult
          ) {
            return settled.elicitationResult;
          }
          if ("timedOut" in waitResult) {
            pending.cancelled = true;
            const entry = requestLedger.get(requestId);
            if (entry?.kind === "user-input" && entry.state === "pending") entry.cancelled = true;
            yield* Deferred.succeed(answersDeferred, {});
          }
          const answers = "timedOut" in waitResult ? {} : waitResult.answers;
          let resolvedAt = new Date().toISOString();
          return yield* resolveClaudeRequest<ElicitationResult>(
            context,
            requestId,
            options.signal,
            (cancelled) =>
              Effect.gen(function* () {
                const resolvedStamp = yield* makeEventStamp();
                resolvedAt = resolvedStamp.createdAt;
                yield* offerRuntimeEvent(context, {
                  type: "user-input.resolved",
                  eventId: resolvedStamp.eventId,
                  provider: PROVIDER,
                  createdAt: resolvedStamp.createdAt,
                  threadId: context.session.threadId,
                  ...(context.turnState
                    ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
                    : {}),
                  requestId: asRuntimeRequestId(requestId),
                  payload: {
                    answers:
                      cancelled() || pending.cancelled
                        ? {}
                        : Object.fromEntries(
                            Object.keys(answers).map((key) => [key, "[redacted]"]),
                          ),
                  },
                  providerRefs: nativeProviderRefs(context),
                  raw: claudeSdkPermissionRuntimeRaw("onElicitation/resolved"),
                });
              }),
            (cancelled) => {
              const elicitationResult =
                cancelled || pending.cancelled
                  ? ({ action: "cancel" } satisfies ElicitationResult)
                  : ({
                      action: "accept",
                      content: elicitationContent(answers),
                    } satisfies ElicitationResult);
              pendingUserInputs.delete(requestId);
              const finalAnswers = elicitationResult.action === "cancel" ? {} : answers;
              context.resolvedUserInputs.set(requestId, finalAnswers);
              const entry: ResolvedUserInputLedgerEntry = {
                kind: "user-input",
                state: "resolved",
                requestId,
                createdAt,
                resolvedAt,
                answers: finalAnswers,
                elicitationResult,
                sensitive: true,
                providerRequestId: options.requestId,
              };
              return { entry, result: elicitationResult };
            },
          );
        }).pipe(Effect.ensuring(cancelAbandonedClaudeRequest(context, requestId, deps)));
      }),
    );

  return { handleAskUserQuestion, onElicitation };
}
