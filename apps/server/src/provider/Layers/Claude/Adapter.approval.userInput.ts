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

const MCP_ELICITATION_TIMEOUT_MS = 120_000;

function elicitationContent(
  answers: ProviderUserInputAnswers,
): Record<string, string | number | boolean | string[]> {
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      content[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      content[key] = value;
    }
  }
  return content;
}

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

    const existingInput = requestLedger.get(requestId);
    if (existingInput?.kind === "user-input" && existingInput.state === "resolved") {
      if (existingInput.result) return existingInput.result;
    }
    if (existingInput?.kind === "user-input" && existingInput.state === "pending") {
      const answers = yield* Deferred.await(existingInput.answers);
      const resolved = requestLedger.get(requestId);
      if (resolved?.kind === "user-input" && resolved.state === "resolved" && resolved.result) {
        return resolved.result;
      }
      return {
        behavior: "allow",
        updatedInput: { questions: toolInput.questions, answers },
      } satisfies PermissionResult;
    }

    const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
    const questions: Array<UserInputQuestion> = rawQuestions.map(
      (question: Record<string, unknown>, index: number) => ({
        id:
          typeof question.question === "string" && question.question.length > 0
            ? question.question
            : `q-${index}`,
        header: typeof question.header === "string" ? question.header : `Question ${index + 1}`,
        question: typeof question.question === "string" ? question.question : "",
        options: Array.isArray(question.options)
          ? question.options.map((option: Record<string, unknown>) => ({
              label: typeof option.label === "string" ? option.label : "",
              description: typeof option.description === "string" ? option.description : "",
            }))
          : [],
        multiSelect: typeof question.multiSelect === "boolean" ? question.multiSelect : false,
      }),
    );
    const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
    let aborted = false;
    const pendingInput: PendingUserInput = {
      questions,
      answers: answersDeferred,
      cancelled: false,
    };
    const requestedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent(context, {
      type: "user-input.requested",
      eventId: requestedStamp.eventId,
      provider: PROVIDER,
      createdAt: requestedStamp.createdAt,
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
    pendingUserInputs.set(requestId, pendingInput);
    const pendingLedgerEntry: PendingUserInputLedgerEntry = {
      kind: "user-input",
      state: "pending",
      requestId,
      createdAt: requestedStamp.createdAt,
      questions,
      answers: answersDeferred,
      cancelled: false,
      providerRequestId: callback.requestId,
      ...(callback.agentId ? { providerAgentId: callback.agentId } : {}),
      providerItemId: callback.toolUseId,
    };
    requestLedger.set(requestId, pendingLedgerEntry);
    trimRequestLedger(requestLedger);

    const onAbort = () => {
      if (!pendingUserInputs.has(requestId)) return;
      aborted = true;
      pendingUserInputs.delete(requestId);
      runFork(Deferred.succeed(answersDeferred, {} as ProviderUserInputAnswers));
    };
    callbackOptions.signal.addEventListener("abort", onAbort, { once: true });
    const answers = yield* Deferred.await(answersDeferred);
    callbackOptions.signal.removeEventListener("abort", onAbort);
    pendingUserInputs.delete(requestId);

    const resolvedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent(context, {
      type: "user-input.resolved",
      eventId: resolvedStamp.eventId,
      provider: PROVIDER,
      createdAt: resolvedStamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      requestId: asRuntimeRequestId(requestId),
      payload: pendingInput.sensitive
        ? { answers: Object.fromEntries(Object.keys(answers).map((key) => [key, "[redacted]"])) }
        : { answers },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: callback.toolUseId,
        providerRequestId: callback.requestId,
        ...(callback.agentId ? { providerAgentId: callback.agentId } : {}),
      }),
      raw: claudeSdkPermissionRuntimeRaw("canUseTool/AskUserQuestion/resolved"),
    });
    const result: PermissionResult =
      aborted || pendingInput.cancelled
        ? { behavior: "deny", message: "User cancelled tool execution." }
        : {
            behavior: "allow",
            updatedInput: { questions: toolInput.questions, answers },
          };
    const resolvedEntry: ResolvedUserInputLedgerEntry = {
      kind: "user-input",
      state: "resolved",
      requestId,
      createdAt: requestedStamp.createdAt,
      resolvedAt: resolvedStamp.createdAt,
      answers,
      result,
      providerRequestId: callback.requestId,
      ...(callback.agentId ? { providerAgentId: callback.agentId } : {}),
      providerItemId: callback.toolUseId,
    };
    requestLedger.set(requestId, resolvedEntry);
    trimRequestLedger(requestLedger);
    return result;
  });

  const onElicitation: OnElicitation = (
    request: ElicitationRequest,
    options: { readonly signal: AbortSignal },
  ) =>
    runPromise(
      Effect.gen(function* () {
        const context = yield* Ref.get(contextRef);
        if (!context) return { action: "cancel" } satisfies ElicitationResult;
        const requestId = ApprovalRequestId.makeUnsafe(
          request.elicitationId ?? crypto.randomUUID(),
        );
        const existing = requestLedger.get(requestId);
        if (existing?.kind === "user-input" && existing.state === "resolved") {
          return existing.elicitationResult ?? ({ action: "cancel" } satisfies ElicitationResult);
        }
        if (existing?.kind === "user-input" && existing.state === "pending") {
          const answers = yield* Deferred.await(existing.answers);
          const resolved = requestLedger.get(requestId);
          if (resolved?.kind === "user-input" && resolved.state === "resolved") {
            return resolved.elicitationResult ?? ({ action: "cancel" } satisfies ElicitationResult);
          }
          return existing.cancelled || options.signal.aborted
            ? ({ action: "cancel" } satisfies ElicitationResult)
            : ({
                action: "accept",
                content: elicitationContent(answers),
              } satisfies ElicitationResult);
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
          ...(request.elicitationId ? { providerRequestId: request.elicitationId } : {}),
        });
        trimRequestLedger(requestLedger);
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
        const onAbort = () => {
          const current = pendingUserInputs.get(requestId);
          if (!current) return;
          current.cancelled = true;
          runFork(Deferred.succeed(answersDeferred, {} as ProviderUserInputAnswers));
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        const waitResult = yield* Effect.race(
          Deferred.await(answersDeferred).pipe(Effect.map((answers) => ({ answers }) as const)),
          Effect.sleep(Duration.millis(MCP_ELICITATION_TIMEOUT_MS)).pipe(
            Effect.as({ timedOut: true } as const),
          ),
        );
        options.signal.removeEventListener("abort", onAbort);
        if ("timedOut" in waitResult) {
          pending.cancelled = true;
          yield* Deferred.succeed(answersDeferred, {});
        }
        const answers = "timedOut" in waitResult ? {} : waitResult.answers;
        const cancelled = "timedOut" in waitResult || pending.cancelled || options.signal.aborted;
        const elicitationResult = cancelled
          ? ({ action: "cancel" } satisfies ElicitationResult)
          : ({
              action: "accept",
              content: elicitationContent(answers),
            } satisfies ElicitationResult);
        pendingUserInputs.delete(requestId);
        context.resolvedUserInputs.set(requestId, answers);
        const resolvedStamp = yield* makeEventStamp();
        requestLedger.set(requestId, {
          kind: "user-input",
          state: "resolved",
          requestId,
          createdAt,
          resolvedAt: resolvedStamp.createdAt,
          answers,
          elicitationResult,
          sensitive: true,
          ...(request.elicitationId ? { providerRequestId: request.elicitationId } : {}),
        });
        trimRequestLedger(requestLedger);
        yield* offerRuntimeEvent(context, {
          type: "user-input.resolved",
          eventId: resolvedStamp.eventId,
          provider: PROVIDER,
          createdAt: resolvedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: {
            answers: Object.fromEntries(Object.keys(answers).map((key) => [key, "[redacted]"])),
          },
          providerRefs: nativeProviderRefs(context),
          raw: claudeSdkPermissionRuntimeRaw("onElicitation/resolved"),
        });
        return elicitationResult;
      }),
    );

  return { handleAskUserQuestion, onElicitation };
}
