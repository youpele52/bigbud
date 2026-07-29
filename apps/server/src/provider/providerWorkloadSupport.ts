import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ProviderKind,
  type ServerProvider,
} from "@bigbud/contracts";

export type ProviderWorkload =
  | "interactive"
  | "unattendedTextGeneration"
  | "learning"
  | "usageAccounting";

export interface ProviderWorkloadSupport {
  readonly interactive: boolean;
  readonly unattendedTextGeneration: boolean;
  readonly learning: boolean;
  readonly usageAccounting: boolean;
}

export type ProviderWorkloadResolution = {
  readonly requested: ModelSelection;
  readonly actual: ModelSelection | null;
  readonly action: "use-requested" | "fallback" | "reject";
  readonly reason: string | null;
};

/**
 * Provider capabilities that are independent of whether a provider is enabled
 * or currently healthy. Runtime callers should pass provider snapshots when
 * health is relevant so a fallback is only selected from ready providers.
 */
const PROVIDER_WORKLOAD_SUPPORT = {
  codex: {
    interactive: true,
    unattendedTextGeneration: true,
    learning: true,
    usageAccounting: true,
  },
  claudeAgent: {
    interactive: true,
    unattendedTextGeneration: true,
    learning: true,
    usageAccounting: true,
  },
  cliProxy: {
    interactive: true,
    unattendedTextGeneration: false,
    learning: false,
    usageAccounting: false,
  },
  copilot: {
    interactive: true,
    unattendedTextGeneration: true,
    learning: true,
    usageAccounting: true,
  },
  kilocode: {
    interactive: true,
    unattendedTextGeneration: true,
    learning: true,
    usageAccounting: true,
  },
  opencode: {
    interactive: true,
    unattendedTextGeneration: true,
    learning: true,
    usageAccounting: true,
  },
  pi: {
    interactive: true,
    unattendedTextGeneration: true,
    learning: true,
    usageAccounting: true,
  },
  cursor: {
    interactive: true,
    unattendedTextGeneration: true,
    learning: true,
    usageAccounting: false,
  },
  devin: {
    interactive: true,
    unattendedTextGeneration: true,
    learning: true,
    usageAccounting: false,
  },
} as const satisfies Record<ProviderKind, ProviderWorkloadSupport>;

/** Preferred actual implementations for generic unattended text generation. */
export const TEXT_GENERATION_FALLBACK_ORDER = ["codex", "claudeAgent", "cursor"] as const;

const UNAVAILABLE_PROVIDER_WORKLOAD_SUPPORT: ProviderWorkloadSupport = {
  interactive: false,
  unattendedTextGeneration: false,
  learning: false,
  usageAccounting: false,
};

export function providerWorkloadSupport(provider: ProviderKind | string): ProviderWorkloadSupport {
  return (
    PROVIDER_WORKLOAD_SUPPORT[provider as ProviderKind] ?? UNAVAILABLE_PROVIDER_WORKLOAD_SUPPORT
  );
}

export function supportsProviderWorkload(
  provider: ProviderKind | string,
  workload: ProviderWorkload,
): boolean {
  return providerWorkloadSupport(provider)[workload];
}

function isReadyProvider(provider: ServerProvider): boolean {
  return provider.enabled && provider.status === "ready";
}

function selectionForProvider(provider: ProviderKind): ModelSelection {
  return {
    provider,
    model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[provider],
  } as ModelSelection;
}

/**
 * Resolve a workload without changing interactive selections. A null actual
 * selection is an explicit failure: callers must surface it instead of
 * inventing a provider or silently routing through an unrelated adapter.
 */
export function resolveProviderWorkload(input: {
  readonly requested: ModelSelection;
  readonly workload: ProviderWorkload;
  readonly availableProviders?: ReadonlyArray<ServerProvider>;
  readonly availableProviderKinds?: ReadonlyArray<ProviderKind>;
  readonly fallbackOrder?: ReadonlyArray<ProviderKind>;
}): ProviderWorkloadResolution {
  const { requested, workload } = input;
  const selectedSupport = supportsProviderWorkload(requested.provider, workload);
  const selectedSnapshot = input.availableProviders?.find(
    (provider) => provider.provider === requested.provider,
  );
  const availableKinds = input.availableProviderKinds
    ? new Set(input.availableProviderKinds)
    : undefined;
  const selectedAvailable =
    (availableKinds === undefined || availableKinds.has(requested.provider)) &&
    (selectedSnapshot === undefined || isReadyProvider(selectedSnapshot));

  if (selectedSupport && selectedAvailable) {
    return { requested, actual: requested, action: "use-requested", reason: null };
  }

  if (workload === "interactive") {
    return {
      requested,
      actual: null,
      action: "reject",
      reason: selectedSupport
        ? `Provider '${requested.provider}' is not ready for interactive work.`
        : `Provider '${requested.provider}' does not support interactive work.`,
    };
  }

  const fallbackOrder = input.fallbackOrder ?? TEXT_GENERATION_FALLBACK_ORDER;
  const readyProviders = input.availableProviders
    ? new Set(input.availableProviders.filter(isReadyProvider).map((provider) => provider.provider))
    : undefined;
  const actualProvider = fallbackOrder.find(
    (provider) =>
      provider !== requested.provider &&
      supportsProviderWorkload(provider, workload) &&
      (availableKinds === undefined || availableKinds.has(provider)) &&
      (readyProviders === undefined || readyProviders.has(provider)),
  );

  if (!actualProvider) {
    return {
      requested,
      actual: null,
      action: "reject",
      reason: selectedSupport
        ? `Provider '${requested.provider}' is unavailable for ${workload}, and no supported fallback is available.`
        : `Provider '${requested.provider}' does not support ${workload}, and no supported fallback is available.`,
    };
  }

  return {
    requested,
    actual: selectionForProvider(actualProvider),
    action: "fallback",
    reason: selectedSupport
      ? `Provider '${requested.provider}' is unavailable for ${workload}; using '${actualProvider}'.`
      : `Provider '${requested.provider}' does not support ${workload}; using '${actualProvider}'.`,
  };
}

export function resolveProviderWorkloadSelection(input: {
  readonly requested: ModelSelection;
  readonly workload: ProviderWorkload;
  readonly availableProviders?: ReadonlyArray<ServerProvider>;
  readonly availableProviderKinds?: ReadonlyArray<ProviderKind>;
  readonly fallbackOrder?: ReadonlyArray<ProviderKind>;
}): ModelSelection | null {
  return resolveProviderWorkload(input).actual;
}
