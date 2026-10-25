/**
 * Which provider models a delegating agent may choose (AC6): only what the user could pick in the
 * composer right now. Pure; reads cached provider snapshots and settings, never probes.
 *
 * @module ThreadOrchestrationTools.modelChoice.usable
 */
import {
  type ModelSelection,
  type ProviderKind,
  type ServerProvider,
  type ServerProviderModel,
  PROVIDER_DISPLAY_NAMES,
} from "@bigbud/contracts";
import type { ServerSettings } from "@bigbud/contracts/core/settings.ts";
import type {
  ModelChoiceOption,
  ModelChoiceUnusableReason,
} from "@bigbud/contracts/orchestration/orchestration.delegationModelChoice";
import { modelSelectionKey } from "@bigbud/shared/delegatedModelChoice";
import { hasOpencodeV2NativeTrust } from "@bigbud/shared/opencodeNativeTrust";
import { isRetiredProvider } from "@bigbud/shared/providerLifecycle";

import { isLocalExecutionTarget } from "../executionTargets.ts";
import { supportsProviderExecutionTarget } from "../provider/providerExecutionTargets.ts";

export interface RecentModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly subProviderID?: string | undefined;
  readonly lastUsedAt: string;
}

export interface ModelChoiceContext {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: ServerSettings;
  /** Most recent first, one entry per provider+model+subProviderID. */
  readonly recent: ReadonlyArray<RecentModelSelection>;
  /** The tributary's inherited execution targets. */
  readonly target: {
    readonly providerRuntimeExecutionTargetId?: string | null | undefined;
    readonly workspaceExecutionTargetId?: string | null | undefined;
  };
  /** Any open delivery consumer (OD6). */
  readonly hasInteractiveClient: boolean;
}

function supportsTarget(snapshot: ServerProvider, target: ModelChoiceContext["target"]): boolean {
  if (!isLocalExecutionTarget(target.providerRuntimeExecutionTargetId)) {
    try {
      return supportsProviderExecutionTarget({
        provider: snapshot.provider,
        executionTargetId: target.providerRuntimeExecutionTargetId,
      });
    } catch {
      return false;
    }
  }
  return (
    isLocalExecutionTarget(target.workspaceExecutionTargetId) ||
    snapshot.supportsLocalRuntimeRemoteWorkspace === true
  );
}

/** `null` when the user could run this provider for the tributary right now. */
export function providerUnusableReason(
  snapshot: ServerProvider,
  context: ModelChoiceContext,
): ModelChoiceUnusableReason | null {
  if (isRetiredProvider(snapshot.provider)) return "provider-retired";
  if (context.settings.hiddenComposerProviders.includes(snapshot.provider)) {
    return "provider-hidden";
  }
  if (!snapshot.enabled || snapshot.status === "disabled") return "provider-disabled";
  if (!snapshot.installed) return "provider-not-installed";
  if (snapshot.auth.status === "unauthenticated") return "provider-unauthenticated";
  if (snapshot.status === "error") return "provider-unavailable";
  if (
    snapshot.provider === "opencodeV2" &&
    !hasOpencodeV2NativeTrust(context.settings.providers.opencodeV2)
  ) {
    return "provider-untrusted";
  }
  if (!supportsTarget(snapshot, context.target)) return "unsupported-execution-target";
  return null;
}

export function isUsableProviderModel(model: ServerProviderModel): boolean {
  return model.availability !== "requires-setup";
}

/** The trunk's full selection (with options) for its own model, provider defaults otherwise (OD5). */
export function selectionFor(
  provider: ProviderKind,
  model: Pick<ServerProviderModel, "slug" | "subProviderID">,
  trunk: ModelSelection,
): ModelSelection {
  const candidate = {
    provider,
    model: model.slug,
    ...(model.subProviderID !== undefined ? { subProviderID: model.subProviderID } : {}),
  };
  return modelSelectionKey(candidate) === modelSelectionKey(trunk)
    ? trunk
    : (candidate as ModelSelection);
}

/** Usable models: recent first (newest first), then provider snapshot order. */
export function listRankedUsableModels(
  context: ModelChoiceContext,
  trunk: ModelSelection,
): ReadonlyArray<ModelChoiceOption> {
  const recency = new Map(context.recent.map((entry) => [modelSelectionKey(entry), entry]));
  const trunkKey = modelSelectionKey(trunk);
  const options: ModelChoiceOption[] = [];
  for (const snapshot of context.providers) {
    if (providerUnusableReason(snapshot, context) !== null) continue;
    for (const model of snapshot.models) {
      if (!isUsableProviderModel(model)) continue;
      const selection = selectionFor(snapshot.provider, model, trunk);
      const key = modelSelectionKey(selection);
      options.push({
        selection,
        label: model.name,
        providerLabel: PROVIDER_DISPLAY_NAMES[snapshot.provider] ?? snapshot.provider,
        lastUsedAt: recency.get(key)?.lastUsedAt ?? null,
        isFallback: key === trunkKey,
      });
    }
  }
  const recent = options
    .filter((option) => option.lastUsedAt !== null)
    .toSorted((left, right) => (right.lastUsedAt ?? "").localeCompare(left.lastUsedAt ?? ""));
  return [...recent, ...options.filter((option) => option.lastUsedAt === null)];
}
