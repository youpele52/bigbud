import {
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_KINDS,
  type ProviderKind,
  type ServerProvider,
} from "@bigbud/contracts";
import type { ReactNode } from "react";

import {
  ClaudeAI,
  CopilotIcon,
  CursorIcon,
  DevinIcon,
  type Icon,
  KilocodeIcon,
  OpenAI,
  OpenCodeIcon,
  PiIcon,
} from "../../Icons";

export type ProviderSettingsPath =
  | {
      readonly kind: "binary";
      readonly placeholder: string;
      readonly description: ReactNode;
    }
  | {
      readonly kind: "config";
      readonly placeholder: string;
      readonly description: ReactNode;
    };

export interface ProviderCustomModelsDescriptor {
  readonly description: string;
  readonly placeholder: string;
  readonly example: string;
}

export interface ProviderDescriptor {
  readonly provider: ProviderKind;
  readonly label: string;
  readonly icon: Icon;
  readonly pickerAvailable: boolean;
  readonly isVisible: (providers: ReadonlyArray<ServerProvider> | undefined) => boolean;
  readonly supportsSubProviderID: boolean;
  /** When true, every selectable model must come from the server catalog. */
  readonly catalogAuthoritative: boolean;
  readonly settings: {
    readonly path: ProviderSettingsPath;
    readonly home?: {
      readonly key: "codexHomePath";
      readonly placeholder: string;
      readonly description: ReactNode;
    };
    readonly setupUrl?: string;
  };
  readonly customModels: ProviderCustomModelsDescriptor | null;
  readonly traitsEnabled: boolean;
}

const visible = () => true;
const binary = (placeholder: string, description: ReactNode): ProviderSettingsPath => ({
  kind: "binary",
  placeholder,
  description,
});
const customModels = (
  providerLabel: string,
  placeholder: string,
  example: string,
): ProviderCustomModelsDescriptor => ({
  description: `Save additional ${providerLabel} model slugs for the picker and \`/model\` command.`,
  placeholder,
  example,
});

const DESCRIPTORS_BY_PROVIDER: Record<ProviderKind, ProviderDescriptor> = {
  codex: {
    provider: "codex",
    label: PROVIDER_DISPLAY_NAMES.codex,
    icon: OpenAI,
    pickerAvailable: true,
    isVisible: visible,
    supportsSubProviderID: false,
    catalogAuthoritative: false,
    settings: {
      path: binary("Codex binary path", "Path to the Codex binary"),
      home: {
        key: "codexHomePath",
        placeholder: "CODEX_HOME",
        description: "Optional custom Codex home and config directory.",
      },
    },
    customModels: customModels("Codex", "your-codex-model-slug", "gpt-6.7-codex-ultra-preview"),
    traitsEnabled: true,
  },
  claudeAgent: {
    provider: "claudeAgent",
    label: PROVIDER_DISPLAY_NAMES.claudeAgent,
    icon: ClaudeAI,
    pickerAvailable: true,
    isVisible: visible,
    supportsSubProviderID: false,
    catalogAuthoritative: false,
    settings: { path: binary("Claude binary path", "Path to the Claude binary") },
    customModels: customModels("Claude", "your-claude-model-slug", "claude-sonnet-5-0"),
    traitsEnabled: true,
  },
  cliProxy: {
    provider: "cliProxy",
    label: PROVIDER_DISPLAY_NAMES.cliProxy,
    icon: ClaudeAI,
    pickerAvailable: true,
    isVisible: (providers) => {
      const snapshot = providers?.find((provider) => provider.provider === "cliProxy");
      return Boolean(snapshot?.enabled && snapshot.installed);
    },
    supportsSubProviderID: false,
    catalogAuthoritative: true,
    settings: {
      path: {
        kind: "config",
        placeholder: "CLIProxyAPI config path",
        description:
          "Path to the CLIProxyAPI configuration used by the isolated Claude-compatible client path.",
      },
      setupUrl: "https://help.router-for.me/introduction/quick-start.html",
    },
    customModels: null,
    traitsEnabled: false,
  },
  copilot: {
    provider: "copilot",
    label: PROVIDER_DISPLAY_NAMES.copilot,
    icon: CopilotIcon,
    pickerAvailable: true,
    isVisible: visible,
    supportsSubProviderID: false,
    catalogAuthoritative: false,
    settings: {
      path: binary("Copilot binary path", "Path to the GitHub Copilot CLI binary"),
    },
    customModels: customModels("GitHub Copilot", "your-copilot-model-slug", "gpt-5"),
    traitsEnabled: true,
  },
  kilocode: {
    provider: "kilocode",
    label: PROVIDER_DISPLAY_NAMES.kilocode,
    icon: KilocodeIcon,
    pickerAvailable: true,
    isVisible: visible,
    supportsSubProviderID: true,
    catalogAuthoritative: false,
    settings: { path: binary("KiloCode binary path", "Path to the KiloCode binary") },
    customModels: customModels("KiloCode", "your-kilocode-model-slug", "claude-sonnet-4-6"),
    traitsEnabled: true,
  },
  opencode: {
    provider: "opencode",
    label: PROVIDER_DISPLAY_NAMES.opencode,
    icon: OpenCodeIcon,
    pickerAvailable: true,
    isVisible: visible,
    supportsSubProviderID: true,
    catalogAuthoritative: false,
    settings: { path: binary("OpenCode binary path", "Path to the OpenCode binary") },
    customModels: customModels("OpenCode", "your-opencode-model-slug", "claude-sonnet-4-6"),
    traitsEnabled: true,
  },
  pi: {
    provider: "pi",
    label: PROVIDER_DISPLAY_NAMES.pi,
    icon: PiIcon,
    pickerAvailable: true,
    isVisible: visible,
    supportsSubProviderID: true,
    catalogAuthoritative: false,
    settings: { path: binary("Pi binary path", "Path to the Pi binary") },
    customModels: customModels("Pi", "your-pi-model-slug", "anthropic/claude-sonnet-4-20250514"),
    traitsEnabled: true,
  },
  cursor: {
    provider: "cursor",
    label: PROVIDER_DISPLAY_NAMES.cursor,
    icon: CursorIcon,
    pickerAvailable: true,
    isVisible: visible,
    supportsSubProviderID: false,
    catalogAuthoritative: false,
    settings: {
      path: binary("Cursor agent binary path", "Path to the Cursor agent binary (agent CLI)"),
    },
    customModels: customModels("Cursor", "your-cursor-model-slug", "claude-sonnet-4-5"),
    traitsEnabled: true,
  },
  devin: {
    provider: "devin",
    label: PROVIDER_DISPLAY_NAMES.devin,
    icon: DevinIcon,
    pickerAvailable: true,
    isVisible: visible,
    supportsSubProviderID: false,
    catalogAuthoritative: false,
    settings: {
      path: binary("Devin CLI binary path", "Path to the Devin CLI binary (devin CLI)"),
    },
    customModels: customModels("Devin", "your-devin-model-slug", "default"),
    traitsEnabled: true,
  },
};

export const PROVIDER_DESCRIPTORS = PROVIDER_KINDS.map(
  (provider) => DESCRIPTORS_BY_PROVIDER[provider],
);

export const PROVIDER_DESCRIPTOR_BY_KIND = DESCRIPTORS_BY_PROVIDER;
export type ProviderPickerKind = ProviderKind;
export const PROVIDER_OPTIONS = PROVIDER_DESCRIPTORS.map((descriptor) => ({
  value: descriptor.provider,
  label: descriptor.label,
  available: descriptor.pickerAvailable,
}));

export function getProviderDescriptor(provider: ProviderKind): ProviderDescriptor {
  return DESCRIPTORS_BY_PROVIDER[provider];
}

export function getVisibleProviderDescriptors(
  providers: ReadonlyArray<ServerProvider> | undefined,
): ReadonlyArray<ProviderDescriptor> {
  return PROVIDER_DESCRIPTORS.filter((descriptor) => descriptor.isVisible(providers));
}

export function providerSupportsSubProviderID(provider: ProviderKind): boolean {
  return DESCRIPTORS_BY_PROVIDER[provider].supportsSubProviderID;
}
