import type { ProviderRuntimeEvent } from "@bigbud/contracts";

import {
  CLAUDE_AGENT_SDK_VERSION,
  claudeSdkMessageDiscriminator,
  claudeSdkMessageLabel,
} from "./Adapter.sdk.ts";

/**
 * Builds a payload-free diagnostic envelope for all SDK-derived runtime events.
 * Native SDK objects can include prompts, tool results, paths, and credentials.
 */
export function claudeSdkDiagnostic(value: unknown): {
  readonly sdkVersion: string;
  readonly message: string;
} {
  return {
    sdkVersion: CLAUDE_AGENT_SDK_VERSION,
    message: claudeSdkMessageLabel(value),
  };
}

/** Returns only stable SDK envelope metadata for persisted runtime raw fields. */
export function claudeSdkRuntimeRaw(
  value: unknown,
  method: string,
): NonNullable<ProviderRuntimeEvent["raw"]> {
  const discriminator = claudeSdkMessageDiscriminator(value);
  return {
    source: "claude.sdk.message",
    method,
    messageType: discriminator.subtype
      ? `${discriminator.type}:${discriminator.subtype}`
      : discriminator.type,
    payload: claudeSdkDiagnostic(value),
  };
}

export function claudeSdkPermissionRuntimeRaw(
  method: string,
): NonNullable<ProviderRuntimeEvent["raw"]> {
  return {
    source: "claude.sdk.permission",
    method,
    payload: { sdkVersion: CLAUDE_AGENT_SDK_VERSION },
  };
}
