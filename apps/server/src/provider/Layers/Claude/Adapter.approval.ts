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
  DEFAULT_RUNTIME_MODE,
  EventId,
  type ProviderApprovalDecision,
  type RuntimeMode,
} from "@bigbud/contracts";
import { FULL_ACCESS_AUTO_APPROVE_AFTER_MS } from "@bigbud/shared/approvals";
import { Deferred, Effect, Fiber, Ref } from "effect";

import {
  asCanonicalTurnId,
  asRuntimeRequestId,
  classifyRequestType,
  extractExitPlanModePlan,
  nativeProviderRefs,
  summarizeToolRequest,
} from "./Adapter.utils.ts";
import type {
  ClaudeSessionContext,
  PendingApproval,
  PendingUserInput,
  UnstampedProviderRuntimeEvent,
} from "./Adapter.types.ts";
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

export interface ApprovalHandlerDeps {
  readonly makeEventStamp: () => Effect.Effect<{
    eventId: EventId;
    createdAt: string;
  }>;
  readonly offerRuntimeEvent: (event: UnstampedProviderRuntimeEvent) => Effect.Effect<void>;
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
    runtimeMode,
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
        decision === "acceptForSession" && !context.appliedSessionPermissionRequests.has(requestId);
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
    if (!context || !callback) {
      return {
        behavior: "deny",
        message: "Claude session context or callback correlation is unavailable.",
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

    const requestId = ApprovalRequestId.makeUnsafe(callbackOptions.requestId);
    const ledgerEntry = requestLedger.get(requestId);
    if (ledgerEntry?.kind === "approval" && ledgerEntry.state === "resolved") {
      if (ledgerEntry.result) return ledgerEntry.result;
    }
    const existingApproval = pendingApprovals.get(requestId);
    if (existingApproval) {
      const decision = yield* Deferred.await(existingApproval.decision);
      return resultForDecision(
        context,
        requestId,
        toolInput,
        decision,
        existingApproval.suggestions,
      );
    }
    const resolvedDecision = resolvedApprovals.get(requestId);
    if (resolvedDecision !== undefined) {
      return resultForDecision(
        context,
        requestId,
        toolInput,
        resolvedDecision,
        resolvedApprovalSuggestions.get(requestId),
      );
    }
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
        ...(callbackOptions.suggestions?.length
          ? {
              sessionApprovalAvailable: true,
              sessionApprovalLabel: "Allow for this session",
            }
          : {}),
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

    pendingApprovals.set(requestId, pendingApproval);
    const pendingLedgerEntry: PendingApprovalLedgerEntry = {
      kind: "approval",
      state: "pending",
      requestId,
      createdAt: requestedStamp.createdAt,
      requestType,
      ...(detail ? { detail } : {}),
      ...(callbackOptions.suggestions ? { suggestions: callbackOptions.suggestions } : {}),
      decision: decisionDeferred,
      providerRequestId: callback.requestId,
      ...(callback.agentId ? { providerAgentId: callback.agentId } : {}),
      providerItemId: callback.toolUseId,
    };
    requestLedger.set(requestId, pendingLedgerEntry);
    trimRequestLedger(requestLedger);

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
    resolvedApprovals.set(requestId, decision);
    resolvedApprovalSuggestions.set(requestId, pendingApproval.suggestions ?? []);

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
        providerItemId: callback.toolUseId,
        providerRequestId: callback.requestId,
        ...(callback.agentId ? { providerAgentId: callback.agentId } : {}),
      }),
      raw: claudeSdkPermissionRuntimeRaw("canUseTool/decision"),
    });

    const result = resultForDecision(
      context,
      requestId,
      toolInput,
      decision,
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
      createdAt: requestedStamp.createdAt,
      resolvedAt: resolvedStamp.createdAt,
      requestType,
      detail,
      decision,
      suggestions: pendingApproval.suggestions ?? [],
      result: replayResult,
      sessionPermissionApplied: context.appliedSessionPermissionRequests.has(requestId),
      providerRequestId: callback.requestId,
      ...(callback.agentId ? { providerAgentId: callback.agentId } : {}),
      providerItemId: callback.toolUseId,
    };
    requestLedger.set(requestId, resolvedEntry);
    trimRequestLedger(requestLedger);
    return result;
  });

  const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
    runPromise(canUseToolEffect(toolName, toolInput, callbackOptions));

  return { canUseTool, onElicitation };
};
