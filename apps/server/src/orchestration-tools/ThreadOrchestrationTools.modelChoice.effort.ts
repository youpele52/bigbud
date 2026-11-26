import { ModelSelection, type ProviderKind, type ServerProviderModel } from "@bigbud/contracts";
import {
  DelegatedEffort,
  type DelegationEffortDecision,
} from "@bigbud/contracts/orchestration/orchestration.delegationModelChoice";
import { modelSelectionKey } from "@bigbud/shared/delegatedModelChoice";
import { getRawProviderEffort, patchProviderEffort } from "@bigbud/shared/model";
import { Option, Schema } from "effect";

import { isCliProxyNativeEffort } from "../provider/Layers/CliProxy/Capabilities.ts";
import { MuseReasoningEffort } from "../provider/Layers/Muse/Client.schema.ts";
import { isLocalExecutionTarget } from "../executionTargets.ts";
import type { ModelChoiceContext } from "./ThreadOrchestrationTools.modelChoice.usable.ts";

const evidencePolicy = {
  codex: "runtime",
  claudeAgent: "runtime",
  cliProxy: "runtime",
  copilot: "runtime",
  cursor: "runtime",
  devin: "runtime",
  muse: "runtime",
  pi: "runtime",
  opencodeV2: "workspace",
} as const satisfies Record<Exclude<ProviderKind, "opencode">, "runtime" | "workspace">;

const decodeEffort = Schema.decodeUnknownOption(DelegatedEffort);
const isModelSelection = Schema.is(ModelSelection);
const isMuseEffort = Schema.is(MuseReasoningEffort);

export function readDelegatedEffort(request: unknown): DelegationEffortDecision | undefined {
  if (request === null || typeof request !== "object" || !Object.hasOwn(request, "effort")) {
    return undefined;
  }
  const requested = Option.getOrUndefined(decodeEffort((request as { effort: unknown }).effort));
  return requested === undefined ? { reason: "invalid-effort" } : { requested, reason: null };
}

function patchSelection(selection: ModelSelection, effort: string): ModelSelection | undefined {
  const options = patchProviderEffort(selection.provider, selection.options, effort);
  const patched = { ...selection, options };
  return isModelSelection(patched) && getRawProviderEffort(patched.provider, options) === effort
    ? patched
    : undefined;
}

export function indexEffortCatalog(context: ModelChoiceContext) {
  const models = new Map<string, ServerProviderModel | undefined>();
  for (const snapshot of context.providers) {
    for (const model of snapshot.models) {
      const key = modelSelectionKey({ provider: snapshot.provider, model: model.slug, ...model });
      models.set(key, models.has(key) ? undefined : model);
    }
  }
  return models;
}

/** Only native, sendable tiers for this exact identity and location. A local snapshot cannot vouch
 * for a remote runtime; there is no delegated remote catalog source yet. */
export function listDelegatedEffort(
  context: ModelChoiceContext,
  selection: ModelSelection,
  catalog = indexEffortCatalog(context),
) {
  const unknown = { status: "unknown", levels: [] } as const;
  const unsupported = { status: "unsupported", levels: [] } as const;
  const provider = selection.provider;
  if (provider === "opencode") return unsupported;
  if (!isLocalExecutionTarget(context.target.providerRuntimeExecutionTargetId)) return unknown;
  if (provider === "copilot" && selection.model === "auto") return unknown;
  const model = catalog.get(modelSelectionKey(selection));
  const caps = model?.capabilities;
  if (!caps || (caps.effortMetadataOrigin !== "live" && caps.effortMetadataOrigin !== "cache")) {
    return unknown;
  }
  if (
    evidencePolicy[provider] === "workspace" &&
    (!isLocalExecutionTarget(context.target.workspaceExecutionTargetId) ||
      !model?.effortCatalogDirectory ||
      model.effortCatalogDirectory !== context.target.workspaceRoot)
  ) {
    return unknown;
  }
  // Older persisted ACP probes could reuse the pre-switch config when the reply omitted it.
  if ((provider === "cursor" || provider === "devin") && caps.effortMetadataOrigin !== "live") {
    return unknown;
  }
  if (caps.effortMetadataStatus === "verified-unsupported") return unsupported;
  if (caps.effortMetadataStatus !== "verified-supported") return unknown;
  const modes = new Set([
    ...caps.promptInjectedEffortLevels,
    ...(caps.workflowModes?.map((mode) => mode.value) ?? []),
    ...(provider === "claudeAgent" ? ["ultrathink", "ultracode"] : []),
  ]);
  const levels = caps.reasoningEffortLevels.filter(
    ({ value }) =>
      !modes.has(value) &&
      (provider !== "muse" || isMuseEffort(value)) &&
      (provider !== "cliProxy" || isCliProxyNativeEffort(value)) &&
      // An inherited Ultracode workflow pins native effort to xhigh. Don't change that option.
      (selection.provider !== "claudeAgent" ||
        selection.options?.ultracode !== true ||
        !caps.workflowModes?.some((mode) => mode.value === "ultracode") ||
        value === "xhigh") &&
      Option.getOrUndefined(decodeEffort(value)) === value &&
      patchSelection(selection, value) !== undefined,
  );
  return levels.length > 0 ? { status: "supported" as const, levels } : unsupported;
}

export function configureDelegatedEffort(
  effort: DelegationEffortDecision,
  context: ModelChoiceContext,
  selection: ModelSelection,
) {
  if (effort.requested === undefined) return { selection, effort };
  const capability = listDelegatedEffort(context, selection);
  const configured = capability.levels.some((level) => level.value === effort.requested)
    ? patchSelection(selection, effort.requested)
    : undefined;
  if (configured !== undefined) {
    return { selection: configured, effort: { ...effort, configured: effort.requested } };
  }
  return {
    selection,
    effort: {
      ...effort,
      reason: capability.status === "unknown" ? "capabilities-unknown" : "unsupported-effort",
    } satisfies DelegationEffortDecision,
  };
}
