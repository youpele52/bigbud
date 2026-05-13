/**
 * Session event handlers — maps Codex session notification methods to ProviderRuntimeEvents.
 */
import { type ProviderEvent, type ProviderRuntimeEvent, type ThreadId } from "@bigbud/contracts";
import { asObject } from "./Adapter.types.ts";
import { runtimeEventBase } from "./Adapter.stream.base.ts";

export function handleSessionConnecting(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  return [
    {
      ...runtimeEventBase(event, canonicalThreadId),
      type: "session.state.changed",
      payload: {
        state: "starting",
        ...(event.message ? { reason: event.message } : {}),
      },
    },
  ];
}

export function handleSessionReady(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  return [
    {
      ...runtimeEventBase(event, canonicalThreadId),
      type: "session.state.changed",
      payload: {
        state: "ready",
        ...(event.message ? { reason: event.message } : {}),
      },
    },
  ];
}

export function handleSessionStarted(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  return [
    {
      ...runtimeEventBase(event, canonicalThreadId),
      type: "session.started",
      payload: {
        ...(event.message ? { message: event.message } : {}),
        ...(event.payload !== undefined ? { resume: event.payload } : {}),
      },
    },
  ];
}

export function handleSessionExited(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  return [
    {
      ...runtimeEventBase(event, canonicalThreadId),
      type: "session.exited",
      payload: {
        ...(event.message ? { reason: event.message } : {}),
        ...(event.method === "session/closed" ? { exitKind: "graceful" } : {}),
      },
    },
  ];
}

export function handleWindowsSandboxSetupCompleted(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payloadRecord = asObject(event.payload);
  const success = payloadRecord?.success;
  const successMessage = event.message ?? "Windows sandbox setup completed";
  const failureMessage = event.message ?? "Windows sandbox setup failed";

  return [
    {
      type: "session.state.changed",
      ...runtimeEventBase(event, canonicalThreadId),
      payload: {
        state: success === false ? "error" : "ready",
        reason: success === false ? failureMessage : successMessage,
        ...(event.payload !== undefined ? { detail: event.payload } : {}),
      },
    },
    ...(success === false
      ? [
          {
            type: "runtime.warning" as const,
            ...runtimeEventBase(event, canonicalThreadId),
            payload: {
              message: failureMessage,
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          },
        ]
      : []),
  ];
}
