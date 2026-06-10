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

export type InstallProviderSettings = {
  provider: ProviderKind;
  title: string;
  binaryPlaceholder: string;
  binaryDescription: ReactNode;
  homePathKey?: "codexHomePath";
  homePlaceholder?: string;
  homeDescription?: ReactNode;
};

export const PROVIDER_SETTINGS: readonly InstallProviderSettings[] = [
  {
    provider: "claudeAgent",
    title: "Claude",
    binaryPlaceholder: "Claude binary path",
    binaryDescription: "Path to the Claude binary",
  },
  {
    provider: "codex",
    title: "Codex",
    binaryPlaceholder: "Codex binary path",
    binaryDescription: "Path to the Codex binary",
    homePathKey: "codexHomePath",
    homePlaceholder: "CODEX_HOME",
    homeDescription: "Optional custom Codex home and config directory.",
  },
  {
    provider: "copilot",
    title: "Copilot",
    binaryPlaceholder: "Copilot binary path",
    binaryDescription: "Path to the GitHub Copilot CLI binary",
  },
  {
    provider: "cursor",
    title: "Cursor",
    binaryPlaceholder: "Cursor agent binary path",
    binaryDescription: "Path to the Cursor agent binary (agent CLI)",
  },
  {
    provider: "devin",
    title: "Devin",
    binaryPlaceholder: "Devin CLI binary path",
    binaryDescription: "Path to the Devin CLI binary (devin CLI)",
  },
  {
    provider: "opencode",
    title: "OpenCode",
    binaryPlaceholder: "OpenCode binary path",
    binaryDescription: "Path to the OpenCode binary",
  },
  {
    provider: "pi",
    title: "Pi",
    binaryPlaceholder: "Pi binary path",
    binaryDescription: "Path to the Pi binary",
  },
] as const;

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

export function createInitialOpenProviderDetails(settings: typeof DEFAULT_UNIFIED_SETTINGS) {
  return {
    codex: Boolean(
      settings.providers.codex.binaryPath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.binaryPath ||
      settings.providers.codex.homePath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.homePath ||
      settings.providers.codex.customModels.length > 0,
    ),
    claudeAgent: Boolean(
      settings.providers.claudeAgent.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.claudeAgent.binaryPath ||
      settings.providers.claudeAgent.customModels.length > 0,
    ),
    copilot: Boolean(
      settings.providers.copilot.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.copilot.binaryPath ||
      settings.providers.copilot.customModels.length > 0,
    ),
    opencode: Boolean(
      settings.providers.opencode.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.opencode.binaryPath ||
      settings.providers.opencode.customModels.length > 0,
    ),
    pi: Boolean(
      settings.providers.pi.binaryPath !== DEFAULT_UNIFIED_SETTINGS.providers.pi.binaryPath ||
      settings.providers.pi.customModels.length > 0,
    ),
    cursor: Boolean(
      settings.providers.cursor.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.cursor.binaryPath ||
      settings.providers.cursor.customModels.length > 0,
    ),
    devin: Boolean(
      settings.providers.devin.binaryPath !== DEFAULT_UNIFIED_SETTINGS.providers.devin.binaryPath ||
      settings.providers.devin.customModels.length > 0,
    ),
  };
}

export function createInitialCustomModelInputs(): Record<ProviderKind, string> {
  return { codex: "", claudeAgent: "", copilot: "", opencode: "", pi: "", cursor: "", devin: "" };
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
    const models: ReadonlyArray<ServerProviderModel> =
      liveProvider?.models ??
      providerConfig.customModels.map((slug) => ({
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
      homePathKey: providerSettings.homePathKey,
      homePlaceholder: providerSettings.homePlaceholder,
      homeDescription: providerSettings.homeDescription,
      binaryPathValue: providerConfig.binaryPath,
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
