import type { DevinSettings, ServerProvider, ServerProviderModel } from "@bigbud/contracts";

import {
  buildServerProvider,
  providerModelsFromSettings,
  type CommandResult,
} from "../../providerSnapshot.ts";
import { EMPTY_CAPABILITIES, PROVIDER } from "./Provider.shared.ts";

export const ABOUT_TIMEOUT_MS = 8_000;

export interface DevinAboutResult {
  readonly version: string | null;
  readonly status: "ready" | "warning" | "error";
  readonly auth: { status: "authenticated" | "unauthenticated" | "unknown" };
  readonly message?: string;
}

function joinProviderMessages(...messages: ReadonlyArray<string | undefined>): string | undefined {
  const parts = messages
    .map((message) => message?.trim())
    .filter((message): message is string => Boolean(message));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function buildDevinProviderSnapshot(input: {
  readonly checkedAt: string;
  readonly devinSettings: DevinSettings;
  readonly parsed: DevinAboutResult;
  readonly discoveredModels?: ReadonlyArray<ServerProviderModel>;
  readonly discoveryWarning?: string;
}): ServerProvider {
  const message = joinProviderMessages(input.parsed.message, input.discoveryWarning);
  return buildServerProvider({
    provider: PROVIDER,
    enabled: input.devinSettings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      input.discoveredModels ?? [],
      PROVIDER,
      input.devinSettings.customModels,
      EMPTY_CAPABILITIES,
    ),
    probe: {
      installed: true,
      version: input.parsed.version,
      status:
        input.discoveryWarning && input.parsed.status === "ready" ? "warning" : input.parsed.status,
      auth: input.parsed.auth,
      ...(message ? { message } : {}),
    },
  });
}

function extractVersionFromStdout(text: string): string | null {
  const match = text.match(/^v?(\d+\.\d+\.\d+)/m);
  return match ? `v${match[1]}` : null;
}

export function parseDevinVersionOutput(result: CommandResult): DevinAboutResult {
  const version =
    extractVersionFromStdout(result.stdout) ?? extractVersionFromStdout(result.stderr);

  if (result.code !== 0) {
    const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (
      lowerOutput.includes("not logged in") ||
      lowerOutput.includes("login required") ||
      lowerOutput.includes("authentication required")
    ) {
      return {
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Devin CLI is not authenticated. Run `devin login` and try again.",
      };
    }
    return {
      version,
      status: "warning",
      auth: { status: "unknown" },
      message: result.stderr?.trim() || "Devin CLI version check failed.",
    };
  }

  return {
    version,
    status: "ready",
    auth: { status: "unknown" },
  };
}
