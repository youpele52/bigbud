import type { ProviderRuntimeEvent } from "@bigbud/contracts";

const MEANINGFUL_PROGRESS_EVENTS = new Set<ProviderRuntimeEvent["type"]>([
  "session.state.changed",
  "turn.started",
  "turn.plan.updated",
  "turn.proposed.delta",
  "turn.proposed.completed",
  "turn.diff.updated",
  "item.started",
  "item.completed",
  "content.delta",
  "request.opened",
  "request.resolved",
  "user-input.requested",
  "user-input.resolved",
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed",
  "task.removed",
  "hook.started",
  "hook.progress",
  "hook.completed",
  "tool.progress",
  "tool.summary",
]);

export function isMeaningfulProviderProgress(event: ProviderRuntimeEvent): boolean {
  return MEANINGFUL_PROGRESS_EVENTS.has(event.type);
}

export function isTerminalProviderEvent(event: ProviderRuntimeEvent): boolean {
  return (
    event.type === "turn.completed" ||
    event.type === "turn.aborted" ||
    event.type === "session.exited"
  );
}

/**
 * An explicitly flagged recovery redelivery of an already-settled terminal
 * outcome (today only Muse journal recovery emits it, with a stable event
 * ID). Publication may proceed despite an existing liveness claim so a
 * canonical outcome lost in the claim-to-delivery crash window can be
 * delivered; canonical ingestion drops it when the turn is proven settled.
 * Unflagged events keep the existing claim-suppression behavior.
 */
export function isRecoveryRedeliveryEvent(event: ProviderRuntimeEvent): boolean {
  return (
    event.type === "turn.completed" &&
    "recoveryRedelivery" in event.payload &&
    event.payload.recoveryRedelivery === true
  );
}
