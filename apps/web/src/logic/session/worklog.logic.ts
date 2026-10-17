/**
 * Work log derivation: extracts, normalises, and collapses tool activity
 * entries from OrchestrationThreadActivity streams into WorkLogEntry arrays.
 *
 * Shared lifecycle derivation stays authoritative. Renderer-only tool identity metadata
 * lets display/copy use retained provider envelopes without changing stored activities.
 */

import type { OrchestrationThreadActivity, TurnId } from "@bigbud/contracts";
import {
  deriveWorkLogEntries as deriveSharedWorkLogEntries,
  type WorkLogEntry as SharedWorkLogEntry,
} from "@bigbud/shared/workLog";
import {
  readOwnedToolPresentation,
  type ToolPresentationIdentity,
} from "../../lib/toolPresentation.payload";

export interface WorkLogEntry extends SharedWorkLogEntry {
  readonly toolPresentation?: ToolPresentationIdentity;
}

/** Enrich only derived UI rows; lifecycle collapsing and raw event data remain unchanged. */
export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): WorkLogEntry[] {
  const entries = deriveSharedWorkLogEntries(activities, latestTurnId);
  const identities = new Map<string, ToolPresentationIdentity>();
  for (const activity of activities) {
    if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") continue;
    const identity = readOwnedToolPresentation(activity.payload);
    if (identity) identities.set(activity.id, identity);
  }
  return entries.map((entry) => {
    const toolPresentation = identities.get(entry.id);
    if (!toolPresentation) return entry;
    const presented = Object.assign({}, entry, { toolPresentation });
    if (toolPresentation.action && !entry.toolAction)
      presented.toolAction = toolPresentation.action;
    return presented;
  });
}

export {
  extractWorkLogPayloadDetails,
  isPlanBoundaryToolActivity,
  type WorkLogPayloadDetails,
} from "@bigbud/shared/workLog";
