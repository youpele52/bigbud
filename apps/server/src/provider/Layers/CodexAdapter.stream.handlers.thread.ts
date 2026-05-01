/**
 * Thread and realtime event handlers — maps Codex thread notification methods to ProviderRuntimeEvents.
 */
import { type ProviderEvent, type ProviderRuntimeEvent, type ThreadId } from "@bigbud/contracts";

import { asString, asObject } from "./CodexAdapter.types.ts";
import { runtimeEventBase } from "./CodexAdapter.stream.base.ts";
import { normalizeCodexTokenUsage, toThreadState } from "./CodexAdapter.stream.utils.ts";

// ---------------------------------------------------------------------------
// Thread events
// ---------------------------------------------------------------------------

export function handleThreadStarted(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const payloadThreadId = asString(asObject(payload?.thread)?.id);
  const providerThreadId = payloadThreadId ?? asString(payload?.threadId);
  if (!providerThreadId) {
    return [];
  }
  return [
    {
      ...runtimeEventBase(event, canonicalThreadId),
      type: "thread.started",
      payload: { providerThreadId },
    },
  ];
}

export function handleThreadStateChanged(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  return [
    {
      type: "thread.state.changed",
      ...runtimeEventBase(event, canonicalThreadId),
      payload: {
        state:
          event.method === "thread/archived"
            ? "archived"
            : event.method === "thread/closed"
              ? "closed"
              : event.method === "thread/compacted"
                ? "compacted"
                : toThreadState(asObject(payload?.thread)?.state ?? payload?.state),
        ...(event.payload !== undefined ? { detail: event.payload } : {}),
      },
    },
  ];
}

export function handleThreadNameUpdated(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  return [
    {
      type: "thread.metadata.updated",
      ...runtimeEventBase(event, canonicalThreadId),
      payload: {
        ...(asString(payload?.threadName) ? { name: asString(payload?.threadName) } : {}),
        ...(event.payload !== undefined ? { metadata: asObject(event.payload) } : {}),
      },
    },
  ];
}

export function handleThreadTokenUsageUpdated(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const tokenUsage = asObject(payload?.tokenUsage);
  const normalizedUsage = normalizeCodexTokenUsage(tokenUsage ?? event.payload);
  if (!normalizedUsage) {
    return [];
  }
  return [
    {
      type: "thread.token-usage.updated",
      ...runtimeEventBase(event, canonicalThreadId),
      payload: { usage: normalizedUsage },
    },
  ];
}

// ---------------------------------------------------------------------------
// Realtime thread events
// ---------------------------------------------------------------------------

export function handleThreadRealtimeStarted(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const realtimeSessionId = asString(payload?.realtimeSessionId);
  return [
    {
      type: "thread.realtime.started",
      ...runtimeEventBase(event, canonicalThreadId),
      payload: { realtimeSessionId },
    },
  ];
}

export function handleThreadRealtimeItemAdded(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  return [
    {
      type: "thread.realtime.item-added",
      ...runtimeEventBase(event, canonicalThreadId),
      payload: { item: event.payload ?? {} },
    },
  ];
}

export function handleThreadRealtimeTranscript(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  return [
    {
      type: "thread.realtime.item-added",
      ...runtimeEventBase(event, canonicalThreadId),
      payload: { item: event.payload ?? {} },
    },
  ];
}

export function handleThreadRealtimeAudioDelta(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  return [
    {
      type: "thread.realtime.audio.delta",
      ...runtimeEventBase(event, canonicalThreadId),
      payload: { audio: event.payload ?? {} },
    },
  ];
}

export function handleThreadRealtimeError(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const message = asString(payload?.message) ?? event.message ?? "Realtime error";
  return [
    {
      type: "thread.realtime.error",
      ...runtimeEventBase(event, canonicalThreadId),
      payload: { message },
    },
  ];
}

export function handleThreadRealtimeClosed(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  return [
    {
      type: "thread.realtime.closed",
      ...runtimeEventBase(event, canonicalThreadId),
      payload: { reason: event.message },
    },
  ];
}
