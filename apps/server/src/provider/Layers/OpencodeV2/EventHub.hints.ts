import type { OpenCodeEvent } from "@opencode/client";

/** Both pinned contracts permit this payload-free durable notification without Location.
 * Ignore it, rather than guessing a Location or preempting the prompt whose ack it precedes.
 * No output/terminal/permission inference: ordinary authoritative polling repairs status.
 */
export function isV2LocationlessExecutionStart(event: OpenCodeEvent, sessionID: string): boolean {
  return (
    event.type === "session.execution.started" &&
    event.location === undefined &&
    event.durable?.version === 1 &&
    event.durable.aggregateID === sessionID &&
    Number.isSafeInteger(event.durable.seq) &&
    event.durable.seq >= 0
  );
}
