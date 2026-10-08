/**
 * ClaudeAdapter approval and user-input handlers.
 *
 * Handles `canUseTool` callbacks from the Claude SDK, routing to
 * approval workflows or user-input collection as appropriate.
 *
 * @module ClaudeAdapter.approval
 */
import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type RuntimeMode,
} from "@bigbud/contracts";
import { Deferred, Effect, Fiber, Ref } from "effect";

import {
  asCanonicalTurnId,
  asRuntimeRequestId,
  classifyRequestType,
  extractExitPlanModePlan,
  nativeProviderRefs,
  summarizeToolRequest,
} from "./Adapter.utils.ts";
import type { ClaudeSessionContext, PendingApproval, PendingUserInput } from "./Adapter.types.ts";
import type { OfferClaudeRuntimeEvent } from "./Adapter.events.ts";
import { PROVIDER } from "./Adapter.types.ts";
import { decodeClaudePermissionCallback } from "./Adapter.sdk.messages.ts";
import { claudeSdkPermissionRuntimeRaw } from "./Adapter.sdk.projections.ts";
import {
  trimRequestLedger,
  type ClaudeRequestLedger,
  type PendingApprovalLedgerEntry,
  type ResolvedApprovalLedgerEntry,
} from "./Adapter.requestLedger.ts";
import type { StreamHandlers } from "./Adapter.stream.ts";
import { makeUserInputHandlers } from "./Adapter.approval.userInput.ts";
import { awaitClaudeCallback } from "./Adapter.approval.wait.ts";
import { claudeSessionPermissionSuggestions } from "./Adapter.approval.permissions.ts";
import { cancelAbandonedClaudeRequest } from "./Adapter.approval.lifecycle.ts";
import { resolveClaudeRequest } from "./Adapter.approval.resolve.ts";

export interface ApprovalHandlerDeps {
  readonly makeEventStamp: () => Effect.Effect<{
    eventId: EventId;
    createdAt: string;
  }>;
  readonly offerRuntimeEvent: OfferClaudeRuntimeEvent;
  readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  readonly emitProposedPlanCompleted: StreamHandlers["emitProposedPlanCompleted"];
  readonly contextRef: Ref.Ref<ClaudeSessionContext | undefined>;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly resolvedApprovals: Map<ApprovalRequestId, ProviderApprovalDecision>;
  readonly resolvedApprovalSuggestions: Map<ApprovalRequestId, ReadonlyArray<PermissionUpdate>>;
  readonly requestLedger: ClaudeRequestLedger;
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
    resolvedApprovals,
    resolvedApprovalSuggestions,
    requestLedger,
  } = deps;
  const { handleAskUserQuestion, onElicitation } = makeUserInputHandlers(deps);

  const resultForDecision = (
    context: ClaudeSessionContext,
    requestId: ApprovalRequestId,
    toolInput: Parameters<CanUseTool>[1],
    decision: ProviderApprovalDecision,
    suggestions?: ReadonlyArray<PermissionUpdate>,
  ): PermissionResult => {
    if (decision === "accept" || decision === "acceptForSession") {
      const applySessionPermissions =
        decision === "acceptForSession" &&
        (suggestions?.length ?? 0) > 0 &&
        !context.appliedSessionPermissionRequests.has(requestId);
      if (applySessionPermissions) {
        context.appliedSessionPermissionRequests.add(requestId);
      }
      return {
        behavior: "allow",
        updatedInput: toolInput,
        ...(applySessionPermissions && suggestions ? { updatedPermissions: [...suggestions] } : {}),
      } satisfies PermissionResult;
    }
    return {
      behavior: "deny",
      message:
        decision === "cancel" ? "User cancelled tool execution." : "User declined tool execution.",
    } satisfies PermissionResult;
  };

  const canUseToolEffect = Effect.fn("canUseTool")(function* (
    toolName: Parameters<CanUseTool>[0],
    toolInput: Parameters<CanUseTool>[1],
    callbackOptions: Parameters<CanUseTool>[2],
  ) {
    const context = yield* Ref.get(contextRef);
    const callback = decodeClaudePermissionCallback(callbackOptions);
    if (!context || context.stopped || context.session.status === "closed" || !callback) {
      return {
        behavior: "deny",
        message: "Claude session context or callback correlation is unavailable.",
      } satisfies PermissionResult;
    }
    if (callbackOptions.signal.aborted) {
      return {
        behavior: "deny",
        message: "User cancelled tool execution.",
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

    // Ordinary bypass/acceptEdits calls are already approved by the SDK. A
    // callback is an explicit ask, including policy and protected-path asks.
    const suggestions = claudeSessionPermissionSuggestions(callbackOptions);
    const requestId = ApprovalRequestId.makeUnsafe(callbackOptions.requestId);
    const ledgerEntry = requestLedger.get(requestId);
    if (ledgerEntry?.kind === "approval" && ledgerEntry.state === "resolved") {
      if (ledgerEntry.result) return ledgerEntry.result;
    }
    if (ledgerEntry?.kind === "approval" && ledgerEntry.state !== "resolved") {
      yield* awaitClaudeCallback(
        callbackOptions.signal,
        Deferred.await(ledgerEntry.completion),
        undefined,
        runFork,
      );
      const resolved = requestLedger.get(requestId);
      if (
        !callbackOptions.signal.aborted &&
        !context.stopped &&
        resolved?.kind === "approval" &&
        resolved.state === "resolved" &&
        resolved.result
      )
        return resolved.result;
      return resultForDecision(context, requestId, toolInput, "cancel");
    }
    const resolvedDecision = resolvedApprovals.get(requestId);
    if (resolvedDecision !== undefined) {
      return resultForDecision(
        context,
        requestId,
        toolInput,
        resolvedDecision,
        callbackOptions.suppressAlwaysAllowRule ? [] : resolvedApprovalSuggestions.get(requestId),
      );
    }
    const requestType = classifyRequestType(toolName);
    const detail = summarizeToolRequest(toolName, toolInput);
    const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
    const pendingApproval: PendingApproval = {
      requestType,
      detail,
      decision: decisionDeferred,
      suggestions,
    };

    const createdAt = new Date().toISOString();
    pendingApprovals.set(requestId, pendingApproval);
    const pendingLedgerEntry: PendingApprovalLedgerEntry = {
      kind: "approval",
      state: "pending",
      requestId,
      createdAt,
      requestType,
      ...(detail ? { detail } : {}),
      suggestions,
      decision: decisionDeferred,
      completion: Deferred.makeUnsafe<void>(),
      providerRequestId: callback.requestId,
      ...(callback.agentId ? { providerAgentId: callback.agentId } : {}),
      providerItemId: callback.toolUseId,
    };
    requestLedger.set(requestId, pendingLedgerEntry);
    trimRequestLedger(requestLedger);
    return yield* Effect.gen(function* () {
      const requestedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent(context, {
        type: "request.opened",
        eventId: requestedStamp.eventId,
        provider: PROVIDER,
        createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: {
          requestType,
          detail,
          sessionApprovalAvailable: suggestions.length > 0,
          ...(suggestions.length ? { sessionApprovalLabel: "Allow for this session" } : {}),
          args: {
            toolName,
            input: toolInput,
            toolUseId: callback.toolUseId,
            ...(callback.agentId ? { agentId: callback.agentId } : {}),
          },
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: callback.toolUseId,
          providerRequestId: callback.requestId,
          ...(callback.agentId ? { providerAgentId: callback.agentId } : {}),
        }),
        raw: claudeSdkPermissionRuntimeRaw("canUseTool/request"),
      });

      const decision = yield* awaitClaudeCallback(
        callbackOptions.signal,
        Deferred.await(decisionDeferred),
        "cancel",
        runFork,
        Deferred.succeed(decisionDeferred, "cancel"),
      );
      const settled = requestLedger.get(requestId);
      if (settled?.kind === "approval" && settled.state === "resolved" && settled.result) {
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
              type: "request.resolved",
              eventId: resolvedStamp.eventId,
              provider: PROVIDER,
              createdAt: resolvedStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              requestId: asRuntimeRequestId(requestId),
              payload: {
                requestType,
                decision: cancelled() ? "cancel" : decision,
              },
              providerRefs: nativeProviderRefs(context, {
                providerItemId: callback.toolUseId,
                providerRequestId: callback.requestId,
                ...(callback.agentId ? { providerAgentId: callback.agentId } : {}),
              }),
              raw: claudeSdkPermissionRuntimeRaw("canUseTool/decision"),
            });
          }),
        (cancelled) => {
          const finalDecision = cancelled ? "cancel" : decision;
          pendingApprovals.delete(requestId);
          resolvedApprovals.set(requestId, finalDecision);
          resolvedApprovalSuggestions.set(requestId, pendingApproval.suggestions ?? []);
          const result = resultForDecision(
            context,
            requestId,
            toolInput,
            finalDecision,
            pendingApproval.suggestions,
          );
          const replayResult: PermissionResult =
            result.behavior === "allow"
              ? {
                  behavior: "allow",
                  ...(result.updatedInput ? { updatedInput: result.updatedInput } : {}),
                }
              : result;
          const resolvedEntry: ResolvedApprovalLedgerEntry = {
            kind: "approval",
            state: "resolved",
            requestId,
            createdAt,
            resolvedAt,
            requestType,
            detail,
            decision: finalDecision,
            suggestions: pendingApproval.suggestions ?? [],
            result: replayResult,
            sessionPermissionApplied: context.appliedSessionPermissionRequests.has(requestId),
            providerRequestId: callback.requestId,
            ...(callback.agentId ? { providerAgentId: callback.agentId } : {}),
            providerItemId: callback.toolUseId,
          };
          return { entry: resolvedEntry, result };
        },
      );
    }).pipe(Effect.ensuring(cancelAbandonedClaudeRequest(context, requestId, deps)));
  });

  const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
    runPromise(canUseToolEffect(toolName, toolInput, callbackOptions));

  return { canUseTool, onElicitation };
};
