import { randomUUID } from "node:crypto";
import { EventId, type ProviderEvent } from "@bigbud/contracts";
import type { CodexSessionContext } from "./codexAppServerManager.types.ts";

/** Session-owned synthetic events use the same epoch envelope as native notifications. */
export function codexSessionEvent(
  context: CodexSessionContext,
  kind: "session" | "error" | "notification",
  method: string,
  message: string,
): ProviderEvent {
  return {
    id: EventId.makeUnsafe(randomUUID()),
    kind,
    provider: "codex",
    threadId: context.session.threadId,
    sessionEpoch: context.session.sessionEpoch!,
    createdAt: new Date().toISOString(),
    method,
    message,
  };
}
