/**
 * Turn and item event handlers — maps Codex turn/item notification methods to ProviderRuntimeEvents.
 */
import { type ProviderEvent, type ProviderRuntimeEvent, type ThreadId } from "@bigbud/contracts";

import { asNumber, asObject, asString } from "./Adapter.types.ts";
import { mapItemLifecycle, runtimeEventBase } from "./Adapter.stream.base.ts";
import {
  contentStreamKindFromMethod,
  itemDetail,
  toCanonicalItemType,
  toTurnStatus,
} from "./Adapter.stream.utils.ts";

// ---------------------------------------------------------------------------
// Turn events
// ---------------------------------------------------------------------------

export function handleTurnStarted(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const turnId = event.turnId;
  if (!turnId) {
    return [];
  }
  const payload = asObject(event.payload);
  const turn = asObject(payload?.turn);
  return [
    {
      ...runtimeEventBase(event, canonicalThreadId),
      turnId,
      type: "turn.started",
      payload: {
        ...(asString(turn?.model) ? { model: asString(turn?.model) } : {}),
        ...(asString(turn?.effort) ? { effort: asString(turn?.effort) } : {}),
      },
    },
  ];
}

export function handleTurnCompleted(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const turn = asObject(payload?.turn);
  const errorMessage = asString(asObject(turn?.error)?.message);
  return [
    {
      ...runtimeEventBase(event, canonicalThreadId),
      type: "turn.completed",
      payload: {
        state: toTurnStatus(turn?.status),
        ...(asString(turn?.stopReason) ? { stopReason: asString(turn?.stopReason) } : {}),
        ...(turn?.usage !== undefined ? { usage: turn.usage } : {}),
        ...(asObject(turn?.modelUsage) ? { modelUsage: asObject(turn?.modelUsage) } : {}),
        ...(asNumber(turn?.totalCostUsd) !== undefined
          ? { totalCostUsd: asNumber(turn?.totalCostUsd) }
          : {}),
        ...(errorMessage ? { errorMessage } : {}),
      },
    },
  ];
}

export function handleTurnAborted(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  return [
    {
      ...runtimeEventBase(event, canonicalThreadId),
      type: "turn.aborted",
      payload: { reason: event.message ?? "Turn aborted" },
    },
  ];
}

export function handleTurnPlanUpdated(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const steps = Array.isArray(payload?.plan) ? payload.plan : [];
  return [
    {
      ...runtimeEventBase(event, canonicalThreadId),
      type: "turn.plan.updated",
      payload: {
        ...(asString(payload?.explanation) ? { explanation: asString(payload?.explanation) } : {}),
        plan: steps
          .map((entry) => asObject(entry))
          .filter((entry): entry is Record<string, unknown> => entry !== undefined)
          .map((entry) => ({
            step: asString(entry.step) ?? "step",
            status:
              entry.status === "completed" || entry.status === "inProgress"
                ? entry.status
                : "pending",
          })),
      },
    },
  ];
}

export function handleTurnDiffUpdated(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  return [
    {
      ...runtimeEventBase(event, canonicalThreadId),
      type: "turn.diff.updated",
      payload: {
        unifiedDiff:
          asString(payload?.unifiedDiff) ??
          asString(payload?.diff) ??
          asString(payload?.patch) ??
          "",
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Item events
// ---------------------------------------------------------------------------

export function handleItemStarted(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const started = mapItemLifecycle(event, canonicalThreadId, "item.started");
  return started ? [started] : [];
}

export function handleItemCompleted(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const item = asObject(payload?.item);
  const source = item ?? payload;
  if (!source) {
    return [];
  }
  const itemType = source ? toCanonicalItemType(source.type ?? source.kind) : "unknown";
  if (itemType === "plan") {
    const detail = itemDetail(source, payload ?? {});
    if (!detail) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.proposed.completed",
        payload: { planMarkdown: detail },
      },
    ];
  }
  const completed = mapItemLifecycle(event, canonicalThreadId, "item.completed");
  return completed ? [completed] : [];
}

export function handleItemPlanDelta(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const delta =
    event.textDelta ??
    asString(payload?.delta) ??
    asString(payload?.text) ??
    asString(asObject(payload?.content)?.text);
  if (!delta || delta.length === 0) {
    return [];
  }
  return [
    {
      ...runtimeEventBase(event, canonicalThreadId),
      type: "turn.proposed.delta",
      payload: { delta },
    },
  ];
}

export function handleContentDelta(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const delta =
    event.textDelta ??
    asString(payload?.delta) ??
    asString(payload?.text) ??
    asString(asObject(payload?.content)?.text);
  if (!delta || delta.length === 0) {
    return [];
  }
  return [
    {
      ...runtimeEventBase(event, canonicalThreadId),
      type: "content.delta",
      payload: {
        streamKind: contentStreamKindFromMethod(event.method),
        delta,
        ...(typeof payload?.contentIndex === "number"
          ? { contentIndex: payload.contentIndex }
          : {}),
        ...(typeof payload?.summaryIndex === "number"
          ? { summaryIndex: payload.summaryIndex }
          : {}),
      },
    },
  ];
}

export function handleMcpToolCallProgress(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  return [
    {
      ...runtimeEventBase(event, canonicalThreadId),
      type: "tool.progress",
      payload: {
        ...(asString(payload?.toolUseId) ? { toolUseId: asString(payload?.toolUseId) } : {}),
        ...(asString(payload?.toolName) ? { toolName: asString(payload?.toolName) } : {}),
        ...(asString(payload?.summary) ? { summary: asString(payload?.summary) } : {}),
        ...(asNumber(payload?.elapsedSeconds) !== undefined
          ? { elapsedSeconds: asNumber(payload?.elapsedSeconds) }
          : {}),
      },
    },
  ];
}
