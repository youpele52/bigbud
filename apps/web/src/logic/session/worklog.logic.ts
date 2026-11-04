/**
 * Work log derivation: extracts, normalises, and collapses tool activity
 * entries from OrchestrationThreadActivity streams into WorkLogEntry arrays.
 *
 * Shared lifecycle derivation stays authoritative. Renderer-only tool identity metadata
 * lets display/copy use retained provider envelopes without changing stored activities.
 */

import type { OrchestrationThreadActivity, TurnId } from "@bigbud/contracts";
import { Schema } from "effect";
import {
  HTML_RENDER_ACTIVITY_KIND,
  HtmlRenderInput,
} from "@bigbud/contracts/orchestration/htmlRender.ts";
import {
  deriveWorkLogEntries as deriveSharedWorkLogEntries,
  type WorkLogEntry as SharedWorkLogEntry,
} from "@bigbud/shared/workLog";
import {
  readOwnedToolPresentation,
  type ToolPresentationIdentity,
} from "../../lib/toolPresentation.payload";

export interface WorkLogEntry extends SharedWorkLogEntry {
  readonly htmlRender?: HtmlRenderInput;
  readonly toolPresentation?: ToolPresentationIdentity;
}

/** Enrich only derived UI rows; lifecycle collapsing and raw event data remain unchanged. */
export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): WorkLogEntry[] {
  const entries: WorkLogEntry[] = deriveSharedWorkLogEntries(
    activities.filter((activity) => activity.kind !== HTML_RENDER_ACTIVITY_KIND),
    latestTurnId,
  );
  // Visual replies are transcript content, not transient latest-turn work logs.
  for (const activity of activities) {
    if (activity.kind !== HTML_RENDER_ACTIVITY_KIND) continue;
    const parsed = Schema.decodeUnknownOption(HtmlRenderInput)(activity.payload);
    if (parsed._tag === "Some")
      entries.push({
        id: activity.id,
        createdAt: activity.createdAt,
        label: activity.summary,
        tone: "info",
        htmlRender: parsed.value,
      });
  }
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
