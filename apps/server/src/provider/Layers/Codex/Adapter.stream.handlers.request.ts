/**
 * Request, user-input, and Codex-native task event handlers.
 */
import {
  type ProviderEvent,
  type ProviderRuntimeEvent,
  type ProviderUserInputAnswers,
  type ThreadId,
  ProviderApprovalDecision,
} from "@bigbud/contracts";
import { Schema } from "effect";

import { asNumber, asObject, asString } from "./Adapter.types.ts";
import { codexEventBase, codexEventMessage, runtimeEventBase } from "./Adapter.stream.base.ts";
import {
  asRuntimeTaskId,
  extractProposedPlanMarkdown,
  toCanonicalUserInputAnswers,
  toRequestTypeFromKind,
  toRequestTypeFromMethod,
  toRequestTypeFromResolvedPayload,
  toUserInputQuestions,
} from "./Adapter.stream.utils.ts";

// ---------------------------------------------------------------------------
// Request / approval events
// ---------------------------------------------------------------------------

export function handleRequestOpened(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const detail =
    asString(payload?.command) ?? asString(payload?.reason) ?? asString(payload?.prompt);

  if (event.method === "item/tool/requestUserInput") {
    const questions = toUserInputQuestions(payload);
    if (!questions) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.requested",
        payload: { questions },
      },
    ];
  }

  return [
    {
      ...runtimeEventBase(event, canonicalThreadId),
      type: "request.opened",
      payload: {
        requestType: toRequestTypeFromMethod(event.method),
        ...(detail ? { detail } : {}),
        ...(event.payload !== undefined ? { args: event.payload } : {}),
      },
    },
  ];
}

export function handleRequestResolved(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const decision = Schema.decodeUnknownSync(ProviderApprovalDecision)(payload?.decision);
  const requestType =
    event.requestKind !== undefined
      ? toRequestTypeFromKind(event.requestKind)
      : toRequestTypeFromMethod(event.method);
  return [
    {
      ...runtimeEventBase(event, canonicalThreadId),
      type: "request.resolved",
      payload: {
        requestType,
        ...(decision ? { decision } : {}),
        ...(event.payload !== undefined ? { resolution: event.payload } : {}),
      },
    },
  ];
}

export function handleServerRequestResolved(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const requestType =
    toRequestTypeFromResolvedPayload(payload) !== "unknown"
      ? toRequestTypeFromResolvedPayload(payload)
      : event.requestId && event.requestKind !== undefined
        ? toRequestTypeFromKind(event.requestKind)
        : "unknown";
  return [
    {
      ...runtimeEventBase(event, canonicalThreadId),
      type: "request.resolved",
      payload: {
        requestType,
        ...(event.payload !== undefined ? { resolution: event.payload } : {}),
      },
    },
  ];
}

export function handleUserInputAnswered(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  return [
    {
      ...runtimeEventBase(event, canonicalThreadId),
      type: "user-input.resolved",
      payload: {
        answers: toCanonicalUserInputAnswers(
          asObject(event.payload)?.answers as ProviderUserInputAnswers | undefined,
        ),
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Codex-native task events
// ---------------------------------------------------------------------------

export function handleCodexTaskStarted(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const msg = codexEventMessage(payload);
  const taskId = asString(payload?.id) ?? asString(msg?.turn_id);
  if (!taskId) {
    return [];
  }
  return [
    {
      ...codexEventBase(event, canonicalThreadId),
      type: "task.started",
      payload: {
        taskId: asRuntimeTaskId(taskId),
        ...(asString(msg?.collaboration_mode_kind)
          ? { taskType: asString(msg?.collaboration_mode_kind) }
          : {}),
      },
    },
  ];
}

export function handleCodexTaskComplete(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const msg = codexEventMessage(payload);
  const taskId = asString(payload?.id) ?? asString(msg?.turn_id);
  const proposedPlanMarkdown = extractProposedPlanMarkdown(asString(msg?.last_agent_message));
  if (!taskId) {
    if (!proposedPlanMarkdown) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "turn.proposed.completed",
        payload: { planMarkdown: proposedPlanMarkdown },
      },
    ];
  }
  const events: ProviderRuntimeEvent[] = [
    {
      ...codexEventBase(event, canonicalThreadId),
      type: "task.completed",
      payload: {
        taskId: asRuntimeTaskId(taskId),
        status: "completed",
        ...(asString(msg?.last_agent_message)
          ? { summary: asString(msg?.last_agent_message) }
          : {}),
      },
    },
  ];
  if (proposedPlanMarkdown) {
    events.push({
      ...codexEventBase(event, canonicalThreadId),
      type: "turn.proposed.completed",
      payload: { planMarkdown: proposedPlanMarkdown },
    });
  }
  return events;
}

export function handleCodexAgentReasoning(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const msg = codexEventMessage(payload);
  const taskId = asString(payload?.id);
  const description = asString(msg?.text);
  if (!taskId || !description) {
    return [];
  }
  return [
    {
      ...codexEventBase(event, canonicalThreadId),
      type: "task.progress",
      payload: {
        taskId: asRuntimeTaskId(taskId),
        description,
      },
    },
  ];
}

export function handleCodexReasoningContentDelta(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const msg = codexEventMessage(payload);
  const delta = asString(msg?.delta);
  if (!delta) {
    return [];
  }
  return [
    {
      ...codexEventBase(event, canonicalThreadId),
      type: "content.delta",
      payload: {
        streamKind:
          asNumber(msg?.summary_index) !== undefined ? "reasoning_summary_text" : "reasoning_text",
        delta,
        ...(asNumber(msg?.summary_index) !== undefined
          ? { summaryIndex: asNumber(msg?.summary_index) }
          : {}),
      },
    },
  ];
}
