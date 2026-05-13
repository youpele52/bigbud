/**
 * Miscellaneous event handlers — model rerouting, deprecation, config warnings,
 * account updates, MCP OAuth, runtime errors, process stderr, and Windows warnings.
 */
import { type ProviderEvent, type ProviderRuntimeEvent, type ThreadId } from "@bigbud/contracts";

import { asObject, asString } from "./Adapter.types.ts";
import { runtimeEventBase } from "./Adapter.stream.base.ts";
import { isFatalCodexProcessStderrMessage } from "./Adapter.stream.utils.ts";

export function handleModelRerouted(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  return [
    {
      type: "model.rerouted",
      ...runtimeEventBase(event, canonicalThreadId),
      payload: {
        fromModel: asString(payload?.fromModel) ?? "unknown",
        toModel: asString(payload?.toModel) ?? "unknown",
        reason: asString(payload?.reason) ?? "unknown",
      },
    },
  ];
}

export function handleDeprecationNotice(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  return [
    {
      type: "deprecation.notice",
      ...runtimeEventBase(event, canonicalThreadId),
      payload: {
        summary: asString(payload?.summary) ?? "Deprecation notice",
        ...(asString(payload?.details) ? { details: asString(payload?.details) } : {}),
      },
    },
  ];
}

export function handleConfigWarning(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  return [
    {
      type: "config.warning",
      ...runtimeEventBase(event, canonicalThreadId),
      payload: {
        summary: asString(payload?.summary) ?? "Configuration warning",
        ...(asString(payload?.details) ? { details: asString(payload?.details) } : {}),
        ...(asString(payload?.path) ? { path: asString(payload?.path) } : {}),
        ...(payload?.range !== undefined ? { range: payload.range } : {}),
      },
    },
  ];
}

export function handleAccountUpdated(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  return [
    {
      type: "account.updated",
      ...runtimeEventBase(event, canonicalThreadId),
      payload: { account: event.payload ?? {} },
    },
  ];
}

export function handleAccountRateLimitsUpdated(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  return [
    {
      type: "account.rate-limits.updated",
      ...runtimeEventBase(event, canonicalThreadId),
      payload: { rateLimits: event.payload ?? {} },
    },
  ];
}

export function handleMcpOauthCompleted(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  return [
    {
      type: "mcp.oauth.completed",
      ...runtimeEventBase(event, canonicalThreadId),
      payload: {
        success: payload?.success === true,
        ...(asString(payload?.name) ? { name: asString(payload?.name) } : {}),
        ...(asString(payload?.error) ? { error: asString(payload?.error) } : {}),
      },
    },
  ];
}

export function handleRuntimeError(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const message =
    asString(asObject(payload?.error)?.message) ?? event.message ?? "Provider runtime error";
  const willRetry = payload?.willRetry === true;
  return [
    {
      type: willRetry ? "runtime.warning" : "runtime.error",
      ...runtimeEventBase(event, canonicalThreadId),
      payload: {
        message,
        ...(!willRetry ? { class: "provider_error" as const } : {}),
        ...(event.payload !== undefined ? { detail: event.payload } : {}),
      },
    },
  ];
}

export function handleProcessStderr(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const message = event.message ?? "Codex process stderr";
  const isFatal = isFatalCodexProcessStderrMessage(message);
  return [
    isFatal
      ? {
          type: "runtime.error",
          ...runtimeEventBase(event, canonicalThreadId),
          payload: {
            message,
            class: "provider_error" as const,
            ...(event.payload !== undefined ? { detail: event.payload } : {}),
          },
        }
      : {
          type: "runtime.warning",
          ...runtimeEventBase(event, canonicalThreadId),
          payload: {
            message,
            ...(event.payload !== undefined ? { detail: event.payload } : {}),
          },
        },
  ];
}

export function handleWindowsWorldWritableWarning(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  return [
    {
      type: "runtime.warning",
      ...runtimeEventBase(event, canonicalThreadId),
      payload: {
        message: event.message ?? "Windows world-writable warning",
        ...(event.payload !== undefined ? { detail: event.payload } : {}),
      },
    },
  ];
}
