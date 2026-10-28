/**
 * Driver action outcomes in both vocabularies, mapped onto the unchanged
 * `ComputerUseActionOutcome` contract (lean upgrade M4):
 *
 * - 0.9.1: `verified`, `effect ∈ {confirmed, unverifiable, suspected_noop}`,
 *   `path`, `escalation {recommended ∈ {px, foreground, page}, reason}`.
 * - 0.38: `effect` adds `partial` (mapped to `unverifiable`: capture state
 *   before continuing) and `refused` (an error, never a summary); `route`
 *   replaces `path` and is never mapped to it; `escalation {target, reason}`
 *   maps `pixel→px`, `foreground`, `page`, and drops `session`.
 */
import type {
  ComputerUseActionOutcome,
  ComputerUseDeliveryPath,
} from "@bigbud/contracts/orchestration/computerUse.ts";
import { ComputerUseDeliveryPaths } from "@bigbud/contracts/orchestration/computerUse.ts";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

type Effect = NonNullable<ComputerUseActionOutcome["effect"]>;
type Recommended = NonNullable<ComputerUseActionOutcome["escalation"]>["recommended"];

function mapEffect(value: unknown): Effect | undefined {
  if (value === "confirmed" || value === "unverifiable" || value === "suspected_noop") {
    return value;
  }
  return value === "partial" ? "unverifiable" : undefined;
}

function mapEscalation(value: unknown): ComputerUseActionOutcome["escalation"] {
  const escalation = asRecord(value);
  if (!escalation || !nonEmpty(escalation.reason)) return undefined;
  const legacy = escalation.recommended;
  const target = escalation.target;
  const recommended: Recommended | undefined =
    legacy === "px" || legacy === "foreground" || legacy === "page"
      ? legacy
      : target === "pixel"
        ? "px"
        : target === "foreground" || target === "page"
          ? target
          : undefined;
  return recommended ? { recommended, reason: escalation.reason } : undefined;
}

export function actionOutcome(value: unknown): ComputerUseActionOutcome | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const effect = mapEffect(record.effect);
  const escalation = mapEscalation(record.escalation);
  const outcome = {
    ...(typeof record.verified === "boolean" ? { verified: record.verified } : {}),
    ...(effect ? { effect } : {}),
    ...(ComputerUseDeliveryPaths.includes(record.path as ComputerUseDeliveryPath)
      ? { path: record.path as ComputerUseDeliveryPath }
      : {}),
    ...(escalation ? { escalation } : {}),
  } satisfies ComputerUseActionOutcome;
  return Object.keys(outcome).length > 0 ? outcome : undefined;
}

/**
 * Error text for a refusal; `null` for anything else. Defensive: upstream sets
 * `isError: true` on every refusal (`mcp_result.rs`, `tool.rs:6161-6169`), which
 * `CuaDriver.results.ts` already throws on, so this only guards a structured
 * refusal that arrives without the error flag. Shapes read:
 * `{effect: "refused", code, hint | suggestion}` (`tool.rs:5017-5021,6932`),
 * `{status: "refused", refusal: {code, message}}` (`tool.rs:6161-6169`) and
 * the action-result `error: {code, hint}` field.
 */
export function refusedActionMessage(toolName: string, value: unknown): string | null {
  const record = asRecord(value);
  if (!record || (record.effect !== "refused" && record.status !== "refused")) return null;
  const refusal = asRecord(record.refusal);
  const error = asRecord(record.error);
  const code = [record.code, refusal?.code, error?.code].find(nonEmpty) ?? "refused";
  const detail = [
    error?.hint,
    record.hint,
    record.suggestion,
    refusal?.message,
    record.summary,
  ].find(nonEmpty);
  return `Desktop tool '${toolName}' was refused: ${code}${detail ? ` (${detail})` : ""}`;
}
