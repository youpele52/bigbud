import { fromLenientJson } from "@bigbud/shared/schemaJson";
import * as Schema from "effect/Schema";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";

/** A corrupt existing file is not a fresh installation or proof of enable consent. */
export const EXISTING_SERVER_SETTINGS_FALLBACK = {
  ...DEFAULT_SERVER_SETTINGS,
  providers: {
    ...DEFAULT_SERVER_SETTINGS.providers,
    opencodeV2: { ...DEFAULT_SERVER_SETTINGS.providers.opencodeV2, enabled: false },
  },
};

const UnknownJson = fromLenientJson(Schema.Unknown);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Missing V2 intent in an existing sparse file cannot prove consent to enable it. */
export function normalizeExistingOpencodeSettings(raw: string): string {
  const decoded = Schema.decodeUnknownExit(UnknownJson)(raw);
  if (decoded._tag === "Failure") return raw;
  const input = record(decoded.value);
  if (!input) return raw;
  const providers = record(input.providers) ?? {};
  const v2 = record(providers.opencodeV2) ?? {};
  const legacy = record(providers.opencode) ?? {};
  return JSON.stringify({
    ...input,
    providers: {
      ...providers,
      opencode: { ...legacy, enabled: false },
      opencodeV2: { ...v2, enabled: v2.enabled === true },
    },
  });
}

/** Pin even default enable values so future loads preserve explicit preferences. */
export function preserveOpencodeEnablePreference(
  sparseSettings: Record<string, unknown>,
  enabled: boolean,
): void {
  const providers = record(sparseSettings.providers) ?? {};
  sparseSettings.providers = {
    ...providers,
    opencodeV2: { ...record(providers.opencodeV2), enabled },
  };
}
