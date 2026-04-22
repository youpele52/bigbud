/**
 * OpencodeAdapter session helpers — pure utility functions used by session
 * lifecycle methods.
 *
 * @module OpencodeAdapter.session.helpers
 */
import type { ProviderApprovalDecision, ProviderSendTurnInput } from "@bigbud/contracts";

import type { ActiveOpencodeSession } from "./OpencodeAdapter.types.ts";

// ── Model selection type guard ────────────────────────────────────────

export function isOpencodeModelSelection(
  value: unknown,
): value is Extract<
  NonNullable<ProviderSendTurnInput["modelSelection"]>,
  { provider: "opencode" }
> {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    value.provider === "opencode" &&
    "model" in value &&
    typeof value.model === "string"
  );
}

// ── Approval decision mapper ──────────────────────────────────────────

export function approvalDecisionToOpencodeResponse(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

// ── Provider ID resolver ──────────────────────────────────────────────

export async function resolveProviderIDForModel(
  client: ActiveOpencodeSession["client"],
  modelID: string,
): Promise<string | undefined> {
  try {
    const providersResp = await client.config.providers();
    if (providersResp.data) {
      for (const p of providersResp.data.providers) {
        if (p.models && modelID) {
          if (modelID in p.models) return p.id;
          for (const m of Object.values(p.models)) {
            if ((m as { id?: string }).id === modelID) return p.id;
          }
        }
      }
    }
  } catch {
    // fall through
  }
  return undefined;
}
