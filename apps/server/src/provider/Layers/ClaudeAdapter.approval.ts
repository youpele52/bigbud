/**
 * ClaudeAdapter approval and user-input handlers.
 *
 * Handles `canUseTool` callbacks from the Claude SDK, routing to
 * approval workflows or user-input collection as appropriate.
 *
 * @module ClaudeAdapter.approval
 */
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  DEFAULT_RUNTIME_MODE,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  type UserInputQuestion,
} from "@bigbud/contracts";
import { FULL_ACCESS_AUTO_APPROVE_AFTER_MS } from "@bigbud/shared/approvals";
import { Deferred, Effect, Fiber, Random, Ref } from "effect";

import {
  asCanonicalTurnId,
  asRuntimeRequestId,
  classifyRequestType,
  extractExitPlanModePlan,
  nativeProviderRefs,
  summarizeToolRequest,
} from "./ClaudeAdapter.utils.ts";
import type {
  ClaudeSessionContext,
  PendingApproval,
  PendingUserInput,
} from "./ClaudeAdapter.types.ts";
import { PROVIDER } from "./ClaudeAdapter.types.ts";
import type { StreamHandlers } from "./ClaudeAdapter.stream.ts";

export interface ApprovalHandlerDeps {
  readonly makeEventStamp: () => Effect.Effect<{
    eventId: EventId;
    createdAt: string;
  }>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  readonly emitProposedPlanCompleted: StreamHandlers["emitProposedPlanCompleted"];
  readonly contextRef: Ref.Ref<ClaudeSessionContext | undefined>;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly runtimeMode: RuntimeMode | undefined;
}

export const makeApprovalHandlers = (deps: ApprovalHandlerDeps) => {
  const {
    makeEventStamp,
    offerRuntimeEvent,
    runFork,
    runPromise,
    emitProposedPlanCompleted,
    contextRef,
    pendingApprovals,
    pendingUserInputs,
    runtimeMode,
  } = deps;

  /**
   * Handle AskUserQuestion tool calls by emitting a `user-input.requested`
   * runtime event and waiting for the user to respond via `respondToUserInput`.
   */
  const handleAskUserQuestion = Effect.fn("handleAskUserQuestion")(function* (
    context: ClaudeSessionContext,
    toolInput: Record<string, unknown>,
    callbackOptions: { readonly signal: AbortSignal; readonly toolUseID?: string },
  ) {
    const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);

    // Parse questions from the SDK's AskUserQuestion input. Claude SDK >= 2.1.121
    // looks up returned answers by full question text, so the UI draft key must match.
    const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
    const questions: Array<UserInputQuestion> = rawQuestions.map(
      (q: Record<string, unknown>, idx: number) => ({
        id: typeof q.question === "string" && q.question.length > 0 ? q.question : `q-${idx}`,
        header: typeof q.header === "string" ? q.header : `Question ${idx + 1}`,
        question: typeof q.question === "string" ? q.question : "",
        options: Array.isArray(q.options)
          ? q.options.map((opt: Record<string, unknown>) => ({
              label: typeof opt.label === "string" ? opt.label : "",
              description: typeof opt.description === "string" ? opt.description : "",
            }))
          : [],
        multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : false,
      }),
    );

    const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
    let aborted = false;
    const pendingInput: PendingUserInput = {
      questions,
      answers: answersDeferred,
    };

    // Emit user-input.requested so the UI can present the questions.
    const requestedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "user-input.requested",
      eventId: requestedStamp.eventId,
      provider: PROVIDER,
      createdAt: requestedStamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      requestId: asRuntimeRequestId(requestId),
      payload: { questions },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: callbackOptions.toolUseID,
      }),
      raw: {
        source: "claude.sdk.permission",
        method: "canUseTool/AskUserQuestion",
        payload: { toolName: "AskUserQuestion", input: toolInput },
      },
    });

    pendingUserInputs.set(requestId, pendingInput);

    // Handle abort (e.g. turn interrupted while waiting for user input).
    const onAbort = () => {
      if (!pendingUserInputs.has(requestId)) {
        return;
      }
      aborted = true;
      pendingUserInputs.delete(requestId);
      runFork(Deferred.succeed(answersDeferred, {} as ProviderUserInputAnswers));
    };
    callbackOptions.signal.addEventListener("abort", onAbort, { once: true });

    // Block until the user provides answers.
    const answers = yield* Deferred.await(answersDeferred);
    pendingUserInputs.delete(requestId);

    // Emit user-input.resolved so the UI knows the interaction completed.
    const resolvedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "user-input.resolved",
      eventId: resolvedStamp.eventId,
      provider: PROVIDER,
      createdAt: resolvedStamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      requestId: asRuntimeRequestId(requestId),
      payload: { answers },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: callbackOptions.toolUseID,
      }),
      raw: {
        source: "claude.sdk.permission",
        method: "canUseTool/AskUserQuestion/resolved",
        payload: { answers },
      },
    });

    if (aborted) {
      return {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult;
    }

    // Return the answers to the SDK in the expected format:
    // { questions: [...], answers: { questionText: selectedLabel } }
    return {
      behavior: "allow",
      updatedInput: {
        questions: toolInput.questions,
        answers,
      },
    } satisfies PermissionResult;
  });

  const canUseToolEffect = Effect.fn("canUseTool")(function* (
    toolName: Parameters<CanUseTool>[0],
    toolInput: Parameters<CanUseTool>[1],
    callbackOptions: Parameters<CanUseTool>[2],
  ) {
    const context = yield* Ref.get(contextRef);
    if (!context) {
      return {
        behavior: "deny",
        message: "Claude session context is unavailable.",
      } satisfies PermissionResult;
    }

    // Handle AskUserQuestion: surface clarifying questions to the
    // user via the user-input runtime event channel, regardless of
    // runtime mode (plan mode relies on this heavily).
    if (toolName === "AskUserQuestion") {
      return yield* handleAskUserQuestion(context, toolInput, callbackOptions);
    }

    if (toolName === "ExitPlanMode") {
      const planMarkdown = extractExitPlanModePlan(toolInput);
      if (planMarkdown) {
        yield* emitProposedPlanCompleted(context, {
          planMarkdown,
          toolUseId: callbackOptions.toolUseID,
          rawSource: "claude.sdk.permission",
          rawMethod: "canUseTool/ExitPlanMode",
          rawPayload: {
            toolName,
            input: toolInput,
          },
        });
      }

      return {
        behavior: "deny",
        message:
          "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
      } satisfies PermissionResult;
    }

    const resolvedRuntimeMode = runtimeMode ?? DEFAULT_RUNTIME_MODE;
    const autoApproveAfterMs =
      resolvedRuntimeMode === "full-access" ? FULL_ACCESS_AUTO_APPROVE_AFTER_MS : undefined;

    const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);
    const requestType = classifyRequestType(toolName);
    const detail = summarizeToolRequest(toolName, toolInput);
    const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
    const pendingApproval: PendingApproval = {
      requestType,
      detail,
      decision: decisionDeferred,
      ...(callbackOptions.suggestions ? { suggestions: callbackOptions.suggestions } : {}),
    };

    const requestedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "request.opened",
      eventId: requestedStamp.eventId,
      provider: PROVIDER,
      createdAt: requestedStamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      requestId: asRuntimeRequestId(requestId),
      payload: {
        requestType,
        detail,
        ...(autoApproveAfterMs !== undefined ? { autoApproveAfterMs } : {}),
        args: {
          toolName,
          input: toolInput,
          ...(callbackOptions.toolUseID ? { toolUseId: callbackOptions.toolUseID } : {}),
        },
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: callbackOptions.toolUseID,
      }),
      raw: {
        source: "claude.sdk.permission",
        method: "canUseTool/request",
        payload: {
          toolName,
          input: toolInput,
        },
      },
    });

    pendingApprovals.set(requestId, pendingApproval);

    if (autoApproveAfterMs !== undefined) {
      runFork(
        Effect.gen(function* () {
          yield* Effect.sleep(autoApproveAfterMs);
          if (!pendingApprovals.has(requestId)) {
            return;
          }
          pendingApprovals.delete(requestId);
          yield* Deferred.succeed(decisionDeferred, "accept");
        }),
      );
    }

    const onAbort = () => {
      if (!pendingApprovals.has(requestId)) {
        return;
      }
      pendingApprovals.delete(requestId);
      runFork(Deferred.succeed(decisionDeferred, "cancel"));
    };

    callbackOptions.signal.addEventListener("abort", onAbort, {
      once: true,
    });

    const decision = yield* Deferred.await(decisionDeferred);
    pendingApprovals.delete(requestId);

    const resolvedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "request.resolved",
      eventId: resolvedStamp.eventId,
      provider: PROVIDER,
      createdAt: resolvedStamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      requestId: asRuntimeRequestId(requestId),
      payload: {
        requestType,
        decision,
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: callbackOptions.toolUseID,
      }),
      raw: {
        source: "claude.sdk.permission",
        method: "canUseTool/decision",
        payload: {
          decision,
        },
      },
    });

    if (decision === "accept" || decision === "acceptForSession") {
      return {
        behavior: "allow",
        updatedInput: toolInput,
        ...(decision === "acceptForSession" && pendingApproval.suggestions
          ? { updatedPermissions: [...pendingApproval.suggestions] }
          : {}),
      } satisfies PermissionResult;
    }

    return {
      behavior: "deny",
      message:
        decision === "cancel" ? "User cancelled tool execution." : "User declined tool execution.",
    } satisfies PermissionResult;
  });

  const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
    runPromise(canUseToolEffect(toolName, toolInput, callbackOptions));

  return { canUseTool };
};
