/**
 * The single rule that recovers a turn's usage attribution from its `thread.turn-start-requested`
 * payload when the payload carries no `usageAttribution` (requests written before migration 133,
 * and forked first turns). The thread-turns projector applies it to every such request, and
 * migration 157 applies it to the same decoded payloads to backfill turns projected before the
 * projector did, so a replay from any point reproduces what the migration wrote.
 *
 * @module ProjectionTurnRequestUsage
 */
import { PROVIDER_INTERACTION_MODES } from "@bigbud/contracts/constants/runtime.constant.ts";

import type { ProjectionTurnStoredUsage } from "./Services/ProjectionTurns.ts";

/**
 * `usage_attribution_source` of attribution recovered from a request payload. Any non-null source
 * is recorded attribution: the turn repository returns it, so the projector keeps it through
 * `thread.reverted` and later turn updates, in live projections and in baseline replays alike.
 */
export const BACKFILL_USAGE_ATTRIBUTION_SOURCE = "backfill";

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

const MODES: ReadonlyArray<string> = PROVIDER_INTERACTION_MODES;

/**
 * Usage columns recovered from a decoded request payload (as replay decodes it, so a payload kept
 * raw by the removed-provider fallback is read the same way):
 *
 * - provider and model: `usageAttribution`, then `modelSelection`; string values only;
 * - mode: the request's `interactionMode`, string values only;
 * - source: `backfill` only when the result decodes as a complete `UsageAttribution`. Partial
 *   results keep a NULL source; their columns still count for usage.
 */
export const deriveTurnRequestUsage = (payload: unknown): ProjectionTurnStoredUsage => {
  const attribution = field(payload, "usageAttribution");
  const selection = field(payload, "modelSelection");
  const provider = text(field(attribution, "provider")) ?? text(field(selection, "provider"));
  const model = text(field(attribution, "model")) ?? text(field(selection, "model"));
  const interactionMode = text(field(payload, "interactionMode"));
  const complete =
    provider !== null &&
    model !== null &&
    interactionMode !== null &&
    MODES.includes(interactionMode);
  return {
    provider,
    model,
    interactionMode,
    source: complete ? BACKFILL_USAGE_ATTRIBUTION_SOURCE : null,
  };
};
