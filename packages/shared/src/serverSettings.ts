import { ServerSettings } from "@bigbud/contracts";
import { Schema } from "effect";
import { fromLenientJson } from "./schemaJson";

const ServerSettingsJson = fromLenientJson(ServerSettings);

/** Sparse new settings share the TUI; legacy private paths remain isolated until explicitly changed. */
export function resolveOpencodeV2ConnectionMode(value: {
  readonly connectionMode?: "shared" | "isolated";
  readonly binaryPath: string;
  readonly profileRoot: string;
}): "shared" | "isolated" {
  return (
    value.connectionMode ??
    (value.binaryPath.trim() || value.profileRoot.trim() ? "isolated" : "shared")
  );
}

export interface PersistedServerObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
}

export interface PersistedMobileRemoteControlSettings {
  readonly enabled: boolean;
}

export function normalizePersistedServerSettingString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function extractPersistedServerObservabilitySettings(input: {
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
  };
}): PersistedServerObservabilitySettings {
  return {
    otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
    otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl),
  };
}

export function extractPersistedMobileRemoteControlSettings(input: {
  readonly mobileRemoteControl?: {
    readonly enabled?: boolean;
  };
}): PersistedMobileRemoteControlSettings {
  return {
    enabled: input.mobileRemoteControl?.enabled === true,
  };
}

export function parsePersistedServerObservabilitySettings(
  raw: string,
): PersistedServerObservabilitySettings {
  try {
    const decoded = Schema.decodeUnknownSync(ServerSettingsJson)(raw);
    return extractPersistedServerObservabilitySettings(decoded);
  } catch {
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
  }
}

export function parsePersistedMobileRemoteControlSettings(
  raw: string,
): PersistedMobileRemoteControlSettings {
  try {
    const decoded = Schema.decodeUnknownSync(ServerSettingsJson)(raw);
    return extractPersistedMobileRemoteControlSettings(decoded);
  } catch {
    return { enabled: false };
  }
}
