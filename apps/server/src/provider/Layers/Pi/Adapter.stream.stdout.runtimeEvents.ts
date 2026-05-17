import { type ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect } from "effect";

import type { ActivePiSession, PiEmitEvents, PiEventStamp } from "./Adapter.types.ts";
import { eventBase, normalizeString } from "./Adapter.utils.ts";
import type { PiRpcStdoutMessage } from "./RpcProcess.ts";

export const handleRuntimeStatusEvent = Effect.fn("handleRuntimeStatusEvent")(function* (deps: {
  readonly emit: PiEmitEvents;
  readonly session: ActivePiSession;
  readonly stamp: PiEventStamp;
  readonly raw: NonNullable<ProviderRuntimeEvent["raw"]>;
  readonly message: PiRpcStdoutMessage;
}) {
  switch (deps.message.type) {
    case "queue_update": {
      const steeringCount = Array.isArray(deps.message.steering) ? deps.message.steering.length : 0;
      const followUpCount = Array.isArray(deps.message.followUp) ? deps.message.followUp.length : 0;
      if (steeringCount === 0 && followUpCount === 0) {
        return;
      }
      return yield* deps.emit([
        {
          ...eventBase({
            eventId: deps.stamp.eventId,
            createdAt: deps.stamp.createdAt,
            threadId: deps.session.threadId,
            ...(deps.session.activeTurnId ? { turnId: deps.session.activeTurnId } : {}),
            raw: deps.raw,
          }),
          type: "runtime.warning",
          payload: {
            message: `Pi queue updated (${steeringCount} steering, ${followUpCount} follow-up).`,
          },
        },
      ]);
    }
    case "compaction_start": {
      return yield* deps.emit([
        {
          ...eventBase({
            eventId: deps.stamp.eventId,
            createdAt: deps.stamp.createdAt,
            threadId: deps.session.threadId,
            ...(deps.session.activeTurnId ? { turnId: deps.session.activeTurnId } : {}),
            raw: deps.raw,
          }),
          type: "runtime.warning",
          payload: {
            message: `Pi compaction started${deps.message.reason ? ` (${deps.message.reason})` : ""}.`,
          },
        },
      ]);
    }
    case "compaction_end": {
      const aborted = deps.message.aborted === true;
      const willRetry = deps.message.willRetry === true;
      const errorMessage = normalizeString(deps.message.errorMessage);
      return yield* deps.emit([
        {
          ...eventBase({
            eventId: deps.stamp.eventId,
            createdAt: deps.stamp.createdAt,
            threadId: deps.session.threadId,
            ...(deps.session.activeTurnId ? { turnId: deps.session.activeTurnId } : {}),
            raw: deps.raw,
          }),
          type: errorMessage ? "runtime.error" : "runtime.warning",
          payload: {
            message: errorMessage
              ? `Pi compaction failed: ${errorMessage}`
              : aborted
                ? "Pi compaction aborted."
                : willRetry
                  ? "Pi compaction complete. Retrying..."
                  : "Pi compaction complete.",
            ...(errorMessage ? { class: "provider_error" as const } : {}),
          },
        },
      ]);
    }
    case "auto_retry_start": {
      const attempt = typeof deps.message.attempt === "number" ? deps.message.attempt : 1;
      const maxAttempts =
        typeof deps.message.maxAttempts === "number" ? deps.message.maxAttempts : 3;
      const errorMessage = normalizeString(deps.message.errorMessage) ?? "transient error";
      return yield* deps.emit([
        {
          ...eventBase({
            eventId: deps.stamp.eventId,
            createdAt: deps.stamp.createdAt,
            threadId: deps.session.threadId,
            ...(deps.session.activeTurnId ? { turnId: deps.session.activeTurnId } : {}),
            raw: deps.raw,
          }),
          type: "runtime.warning",
          payload: {
            message: `Pi auto-retry ${attempt}/${maxAttempts} after ${errorMessage}.`,
          },
        },
      ]);
    }
    case "auto_retry_end": {
      const success = deps.message.success === true;
      const attempt = typeof deps.message.attempt === "number" ? deps.message.attempt : 1;
      const finalError = normalizeString(deps.message.finalError);
      return yield* deps.emit([
        {
          ...eventBase({
            eventId: deps.stamp.eventId,
            createdAt: deps.stamp.createdAt,
            threadId: deps.session.threadId,
            ...(deps.session.activeTurnId ? { turnId: deps.session.activeTurnId } : {}),
            raw: deps.raw,
          }),
          type: success ? "runtime.warning" : "runtime.error",
          payload: {
            message: success
              ? `Pi auto-retry succeeded on attempt ${attempt}.`
              : `Pi auto-retry failed on attempt ${attempt}${finalError ? `: ${finalError}` : ""}.`,
            ...(success ? {} : { class: "provider_error" as const }),
          },
        },
      ]);
    }
    case "extension_error": {
      const extensionPath = normalizeString(deps.message.extensionPath) ?? "unknown";
      const error = normalizeString(deps.message.error) ?? "Extension error";
      return yield* deps.emit([
        {
          ...eventBase({
            eventId: deps.stamp.eventId,
            createdAt: deps.stamp.createdAt,
            threadId: deps.session.threadId,
            ...(deps.session.activeTurnId ? { turnId: deps.session.activeTurnId } : {}),
            raw: deps.raw,
          }),
          type: "runtime.error",
          payload: {
            message: `Pi extension error in ${extensionPath}: ${error}`,
            class: "provider_error" as const,
          },
        },
      ]);
    }
    default:
      return;
  }
});
