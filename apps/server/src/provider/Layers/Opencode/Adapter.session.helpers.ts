/**
 * OpencodeAdapter session helpers — pure utility functions used by session
 * lifecycle methods.
 *
 * @module OpencodeAdapter.session.helpers
 */
import type {
  ProviderApprovalDecision,
  ProviderSendTurnInput,
  ProviderSession,
} from "@bigbud/contracts";
import type { PermissionRuleset } from "@opencode-ai/sdk/v2";

import type { ActiveOpencodeSession } from "./Adapter.types.ts";

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

// ── Permission rules ──────────────────────────────────────────────────

export function buildOpenCodePermissionRules(
  runtimeMode: ProviderSession["runtimeMode"],
): PermissionRuleset {
  if (runtimeMode === "full-access") {
    return [{ permission: "*", pattern: "*", action: "allow" }];
  }

  const approvalRequiredRules: PermissionRuleset = [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "webfetch", pattern: "*", action: "ask" },
    { permission: "websearch", pattern: "*", action: "ask" },
    { permission: "codesearch", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" },
  ];

  if (runtimeMode === "auto-accept-edits") {
    return [...approvalRequiredRules, { permission: "edit", pattern: "*", action: "allow" }];
  }

  return approvalRequiredRules;
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
