import type { OpenCodeEvent } from "@opencode/client";

const durableHints = new Set<string>([
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.permissions",
  "session.metadata.updated",
  "session.agent.selected",
  "session.model.selected",
]);

/** Native host-scoped notifications may omit Location. They only request authoritative reads;
 * their content never proves output, permission, admission or completion. Unknown events fail closed.
 */
export function isV2LocationlessSessionHint(event: OpenCodeEvent, sessionID: string): boolean {
  if (
    event.location !== undefined ||
    !("sessionID" in event.data) ||
    event.data.sessionID !== sessionID
  )
    return false;
  const durable = "durable" in event ? event.durable : undefined;
  // Usage is a documented ephemeral notification, not a durable completion claim.
  if (event.type === "session.usage.updated" && durable === undefined) return true;
  return (
    durableHints.has(event.type) &&
    durable?.version === 1 &&
    durable.aggregateID === sessionID &&
    Number.isSafeInteger(durable.seq) &&
    durable.seq >= 0
  );
}
