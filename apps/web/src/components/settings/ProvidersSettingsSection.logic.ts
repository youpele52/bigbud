import { type ReactNode } from "react";
import {
  type ProviderKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@bigbud/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@bigbud/contracts/settings";
import { normalizeModelSlug } from "@bigbud/shared/model";
import { Equal } from "effect";
import { MAX_CUSTOM_MODEL_LENGTH, resolveAppModelSelectionState } from "../../models/provider";
import { formatRelativeTime } from "../../utils/timestamp";
import type { ProviderCardData } from "./ProviderCard";
import { PROVIDER_DESCRIPTORS } from "../chat/provider/providerDescriptors";

export type InstallProviderSettings = {
  provider: ProviderKind;
  title: string;
  binaryPlaceholder: string;
  binaryDescription: ReactNode;
  configPath?: boolean;
  homePathKey?: "codexHomePath";
  homePlaceholder?: string;
  homeDescription?: ReactNode;
  setupUrl?: string;
  supportsCustomModels: boolean;
  customModelPlaceholder?: string;
};

export const PROVIDER_SETTINGS: readonly InstallProviderSettings[] = PROVIDER_DESCRIPTORS.map(
  (descriptor) => ({
    provider: descriptor.provider,
    title: descriptor.label,
    binaryPlaceholder: descriptor.settings.path.placeholder,
    binaryDescription: descriptor.settings.path.description,
    ...(descriptor.settings.path.kind === "config" ? { configPath: true } : {}),
    ...(descriptor.settings.home
      ? {
          homePathKey: descriptor.settings.home.key,
          homePlaceholder: descriptor.settings.home.placeholder,
          homeDescription: descriptor.settings.home.description,
        }
      : {}),
    ...(descriptor.settings.setupUrl ? { setupUrl: descriptor.settings.setupUrl } : {}),
    supportsCustomModels: descriptor.customModels !== null,
    ...(descriptor.customModels ? { customModelPlaceholder: descriptor.customModels.example } : {}),
  }),
);

export const PROVIDER_STATUS_STYLES = {
  disabled: { dot: "bg-amber-400" },
  error: { dot: "bg-destructive" },
  ready: { dot: "bg-success" },
  warning: { dot: "bg-warning" },
} as const;

export function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    };
  }
  if (!provider.enabled) {
    return {
      headline: "Disabled",
      detail:
        provider.message ?? "This provider is installed but disabled for new sessions in bigbud.",
    };
  }
  if (!provider.installed) {
    return { headline: "Not found", detail: provider.message ?? "CLI not detected on PATH." };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Authenticated · ${authLabel}` : "Authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return { headline: "Not authenticated", detail: provider.message ?? null };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail:
        provider.message ?? "The provider is installed, but the server could not fully verify it.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: provider.message ?? "The provider failed its startup checks.",
    };
  }
  return {
    headline: "Available",
    detail: provider.message ?? "Installed and ready, but authentication could not be verified.",
  };
}

export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

export function formatProviderLastChecked(lastCheckedAt: string | null) {
  return lastCheckedAt ? formatRelativeTime(lastCheckedAt) : null;
}

export function createInitialOpenProviderDetails(
  settings: typeof DEFAULT_UNIFIED_SETTINGS,
): Record<ProviderKind, boolean> {
  return Object.fromEntries(
    PROVIDER_DESCRIPTORS.map((descriptor) => {
      const current = settings.providers[descriptor.provider];
      const defaults = DEFAULT_UNIFIED_SETTINGS.providers[descriptor.provider];
      const pathDirty =
        descriptor.settings.path.kind === "config"
          ? "configPath" in current &&
            "configPath" in defaults &&
            current.configPath !== defaults.configPath
          : "binaryPath" in current &&
            "binaryPath" in defaults &&
            current.binaryPath !== defaults.binaryPath;
      const homeDirty =
        descriptor.settings.home !== undefined &&
        "homePath" in current &&
        "homePath" in defaults &&
        current.homePath !== defaults.homePath;
      const customModelsDirty =
        descriptor.customModels !== null &&
        "customModels" in current &&
        current.customModels.length > 0;
      return [descriptor.provider, pathDirty || homeDirty || customModelsDirty];
    }),
  ) as Record<ProviderKind, boolean>;
}

export function createInitialCustomModelInputs(): Record<ProviderKind, string> {
  return {
    codex: "",
    claudeAgent: "",
    cliProxy: "",
    copilot: "",
    opencode: "",
    kilocode: "",
    pi: "",
    cursor: "",
    devin: "",
  };
}

export function getAddCustomModelError(input: {
  provider: ProviderKind;
  rawInput: string;
  customModels: ReadonlyArray<string>;
  serverProviders: ReadonlyArray<ServerProvider>;
}) {
  const normalized = normalizeModelSlug(input.rawInput, input.provider);
  if (!normalized) {
    return { normalized: null, error: "Enter a model slug." };
  }
  if (
    input.serverProviders
      .find((candidate) => candidate.provider === input.provider)
      ?.models.some((model) => !model.isCustom && model.slug === normalized)
  ) {
    return { normalized: null, error: "That model is already built in." };
  }
  if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
    return {
      normalized: null,
      error: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
    };
  }
  if (input.customModels.includes(normalized)) {
    return { normalized: null, error: "That custom model is already saved." };
  }
  return { normalized, error: null };
}

export function buildProviderCards(input: {
  serverProviders: ReadonlyArray<ServerProvider>;
  settings: UnifiedSettings;
}): ProviderCardData[] {
  return PROVIDER_SETTINGS.map((providerSettings) => {
    const liveProvider = input.serverProviders.find(
      (candidate) => candidate.provider === providerSettings.provider,
    );
    const providerConfig = input.settings.providers[providerSettings.provider];
    const defaultProviderConfig = DEFAULT_UNIFIED_SETTINGS.providers[providerSettings.provider];
    const statusKey = liveProvider?.status ?? (providerConfig.enabled ? "warning" : "disabled");
    const summary = getProviderSummary(liveProvider);
    const customModels =
      "customModels" in providerConfig
        ? providerConfig.customModels
        : ([] as ReadonlyArray<string>);
    const models: ReadonlyArray<ServerProviderModel> =
      liveProvider?.models ??
      customModels.map((slug) => ({
        slug,
        name: slug,
        isCustom: true,
        capabilities: null,
      }));

    return {
      provider: providerSettings.provider,
      title: providerSettings.title,
      binaryPlaceholder: providerSettings.binaryPlaceholder,
      binaryDescription: providerSettings.binaryDescription,
      configPath: providerSettings.configPath,
      homePathKey: providerSettings.homePathKey,
      homePlaceholder: providerSettings.homePlaceholder,
      homeDescription: providerSettings.homeDescription,
      setupUrl: providerSettings.setupUrl,
      supportsCustomModels: providerSettings.supportsCustomModels,
      customModelPlaceholder: providerSettings.customModelPlaceholder,
      binaryPathValue: "binaryPath" in providerConfig ? providerConfig.binaryPath : "",
      configPathValue: "configPath" in providerConfig ? providerConfig.configPath : "",
      isDirty: !Equal.equals(providerConfig, defaultProviderConfig),
      models,
      providerConfig,
      statusStyle: PROVIDER_STATUS_STYLES[statusKey],
      summary,
      versionLabel: getProviderVersionLabel(liveProvider?.version),
    };
  });
}

export function getLatestProviderCheckedAt(
  serverProviders: ReadonlyArray<ServerProvider>,
): string | null {
  return serverProviders.length > 0
    ? serverProviders.reduce(
        (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
        serverProviders[0]!.checkedAt,
      )
    : null;
}

export function shouldClearTextGenerationSelection(input: {
  settings: UnifiedSettings;
  serverProviders: ReadonlyArray<ServerProvider>;
  provider: ProviderKind;
  checked: boolean;
}) {
  const textGenProvider = resolveAppModelSelectionState(
    input.settings,
    input.serverProviders,
  ).provider;
  return !input.checked && textGenProvider === input.provider;
}
