import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  type OrchestrationProject,
  type OrchestrationThread,
  PROVIDER_KINDS,
  type ProviderKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@bigbud/contracts";
import { normalizeModelSlug } from "@bigbud/shared/model";

import type { MobileDraftThread } from "../lib/mobileDraftThread";

const SUB_PROVIDER_PROVIDERS = new Set<ProviderKind>(["pi", "opencode", "kilocode"]);

export interface MobileModelSelectionContext {
  readonly thread: OrchestrationThread | null;
  readonly draft: MobileDraftThread | null;
  readonly project: OrchestrationProject | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly isRunning: boolean;
}

function isProviderUsable(provider: ServerProvider | undefined): boolean {
  if (!provider) return false;
  if (!provider.enabled) return false;
  if (!provider.installed) return false;
  if (provider.auth.status === "unauthenticated") return false;
  if (provider.status === "error") return false;
  return true;
}

function findReadyProvider(providers: ReadonlyArray<ServerProvider>): ServerProvider | undefined {
  return providers.find((provider) => provider.enabled && provider.status === "ready");
}

function firstUsableProvider(providers: ReadonlyArray<ServerProvider>): ServerProvider | undefined {
  return providers.find(isProviderUsable);
}

function defaultModelSelectionFor(providers: ReadonlyArray<ServerProvider>): ModelSelection {
  const ready = findReadyProvider(providers);
  const candidate = ready ?? firstUsableProvider(providers);
  if (candidate) {
    const firstModel = candidate.models[0];
    const model = firstModel?.slug ?? DEFAULT_MODEL_BY_PROVIDER[candidate.provider];
    return buildSelection(candidate.provider, model, firstModel?.subProviderID);
  }
  const fallbackProvider = PROVIDER_KINDS[0];
  return buildSelection(fallbackProvider, DEFAULT_MODEL_BY_PROVIDER[fallbackProvider], undefined);
}

function buildSelection(
  provider: ProviderKind,
  model: string,
  subProviderID: string | undefined,
): ModelSelection {
  if (SUB_PROVIDER_PROVIDERS.has(provider) && subProviderID) {
    return { provider, model, subProviderID } as ModelSelection;
  }
  return { provider, model };
}

function getProjectModelSelection(project: OrchestrationProject | null): ModelSelection | null {
  return project?.defaultModelSelection ?? null;
}

function getThreadModelSelection(thread: OrchestrationThread | null): ModelSelection | null {
  return thread?.modelSelection ?? null;
}

/**
 * Mirrors the desktop logic in
 * `apps/web/src/components/chat/view/chat-view/chat-view-composer-derived.models.ts`.
 *
 * Returns the model selection that should drive the composer button + the
 * next `thread.turn.start` command. The flow is:
 *
 * 1. If the thread has been started (`thread != null`) and is not currently
 *    running, the thread's `modelSelection` is the source of truth — switching
 *    the provider mid-thread is not allowed on desktop either.
 * 2. Otherwise, prefer the user's pending pick (held in the caller), then
 *    the project default, then the first ready provider's first model, then
 *    a codex fallback.
 */
export function resolveMobileComposerModelSelection(
  context: MobileModelSelectionContext,
  pendingModelSelection: ModelSelection | null,
): ModelSelection {
  const { thread, draft, project, providers } = context;

  if (pendingModelSelection) {
    return pendingModelSelection;
  }

  if (thread) {
    const threadSelection = getThreadModelSelection(thread);
    if (threadSelection) {
      return threadSelection;
    }
  }

  if (draft?.modelSelection) {
    return draft.modelSelection;
  }

  const projectSelection = getProjectModelSelection(project);
  if (projectSelection) {
    return projectSelection;
  }

  return defaultModelSelectionFor(providers);
}

/**
 * True when the picker should be locked. Mirrors desktop: once a thread has
 * actually been started, the provider cannot be swapped from the composer.
 *
 * The signal is `thread.latestTurn !== null || thread.session !== null` —
 * identical to the desktop predicate in
 * `apps/web/src/components/chat/view/ChatView.threadWait.logic.ts`.
 */
export function isMobileComposerModelLocked(
  thread: OrchestrationThread | null,
  draft: MobileDraftThread | null,
): boolean {
  void draft;
  return threadHasStarted(thread);
}

/**
 * Returns the provider a started thread is locked to, or `null` if the
 * thread hasn't been started yet. Mirrors the locked-provider derivation
 * in `apps/web/src/components/chat/view/chat-view/chat-view-composer-derived.models.ts`.
 */
export function resolveMobileLockedProvider(
  thread: OrchestrationThread | null,
  draft: MobileDraftThread | null,
): ProviderKind | null {
  if (!threadHasStarted(thread)) {
    return null;
  }
  void draft;
  return thread?.modelSelection.provider ?? null;
}

function threadHasStarted(thread: OrchestrationThread | null): boolean {
  if (!thread) return false;
  return thread.latestTurn !== null || thread.session !== null;
}

export function getProviderModels(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): ReadonlyArray<ServerProviderModel> {
  return providers.find((candidate) => candidate.provider === provider)?.models ?? [];
}

export function getProviderSnapshotForMobile(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): ServerProvider | undefined {
  return providers.find((candidate) => candidate.provider === provider);
}

/**
 * Apply the server-side model list to a user-supplied model slug. Falls back
 * to the slug itself if the server hasn't enumerated this provider yet, so
 * the picker can still display the previously-known label.
 */
export function resolveComposerModelLabel(
  provider: ProviderKind,
  model: string,
  providers: ReadonlyArray<ServerProvider>,
): string {
  const models = getProviderModels(providers, provider);
  const direct = models.find((option) => option.slug === model);
  if (direct) {
    return direct.name ?? direct.slug;
  }
  const subProviderMatch = model.includes("::")
    ? models.find((option) => `${option.slug}::${option.subProviderID ?? ""}` === model)
    : undefined;
  if (subProviderMatch) {
    return subProviderMatch.name ?? subProviderMatch.slug;
  }
  const normalized = normalizeModelSlug(model, provider) ?? model;
  const aliased = models.find((option) => option.slug === normalized);
  if (aliased) {
    return aliased.name ?? aliased.slug;
  }
  return model;
}
