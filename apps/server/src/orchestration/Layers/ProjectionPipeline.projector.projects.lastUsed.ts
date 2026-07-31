import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";

type ThreadEvent = Extract<OrchestrationEvent, { readonly type: `thread.${string}` }>;
type IgnoredThreadRecencyEvent = Extract<
  ThreadEvent,
  {
    readonly type: "thread.deletion-requested" | "thread.deletion-failed" | "thread.deleted";
  }
>;
export type ProjectRecencyThreadEvent = Exclude<ThreadEvent, IgnoredThreadRecencyEvent>;

const IGNORED_THREAD_RECENCY_EVENTS = new Set<OrchestrationEvent["type"]>([
  "thread.deletion-requested",
  "thread.deletion-failed",
  "thread.deleted",
]);

export function advancesProjectLastUsedAt(
  event: OrchestrationEvent,
): event is ProjectRecencyThreadEvent {
  return event.type.startsWith("thread.") && !IGNORED_THREAD_RECENCY_EVENTS.has(event.type);
}
