import {
  DEFAULT_SERVER_SETTINGS,
  PersistedModelSelection,
  PROVIDER_KINDS,
  ServerSettings,
} from "@bigbud/contracts";
import { fromLenientJson } from "@bigbud/shared/schemaJson";
import { Equal, Schema } from "effect";

const UnknownJson = fromLenientJson(Schema.Unknown);

/** Recover valid settings fields while retaining a well-formed historical selection. */
export function decodeSettingsFieldWise(raw: string): ServerSettings | null {
  const parsed = Schema.decodeUnknownExit(UnknownJson)(raw);
  if (
    parsed._tag === "Failure" ||
    parsed.value === null ||
    typeof parsed.value !== "object" ||
    Array.isArray(parsed.value)
  ) {
    return null;
  }

  const input = parsed.value as Record<string, unknown>;
  const next: Record<string, unknown> = { ...DEFAULT_SERVER_SETTINGS };
  for (const [key, value] of Object.entries(input)) {
    if (key === "providers" && value !== null && typeof value === "object") {
      const providers = { ...DEFAULT_SERVER_SETTINGS.providers } as Record<string, unknown>;
      for (const [providerKey, providerValue] of Object.entries(value as Record<string, unknown>)) {
        if (!PROVIDER_KINDS.includes(providerKey as (typeof PROVIDER_KINDS)[number])) continue;
        const decoded = Schema.decodeUnknownExit(ServerSettings)({
          providers: { [providerKey]: providerValue },
        });
        if (decoded._tag === "Success") {
          providers[providerKey] =
            decoded.value.providers[providerKey as keyof typeof decoded.value.providers];
        }
      }
      next.providers = providers;
      continue;
    }

    const decoded = Schema.decodeUnknownExit(ServerSettings)({ [key]: value });
    if (decoded._tag === "Success") {
      next[key] = decoded.value[key as keyof ServerSettings];
    } else if (
      key === "textGenerationModelSelection" &&
      Schema.is(PersistedModelSelection)(value)
    ) {
      next[key] = value;
    }
  }
  return next as ServerSettings;
}

const ATOMIC_SETTINGS_KEYS: ReadonlySet<string> = new Set(["textGenerationModelSelection"]);

export function stripDefaultServerSettings(
  current: unknown,
  defaults: unknown,
): unknown | undefined {
  if (Array.isArray(current) || Array.isArray(defaults)) {
    return Equal.equals(current, defaults) ? undefined : current;
  }

  if (
    current !== null &&
    defaults !== null &&
    typeof current === "object" &&
    typeof defaults === "object"
  ) {
    const currentRecord = current as Record<string, unknown>;
    const defaultsRecord = defaults as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const key of Object.keys(currentRecord)) {
      if (ATOMIC_SETTINGS_KEYS.has(key)) {
        if (!Equal.equals(currentRecord[key], defaultsRecord[key])) next[key] = currentRecord[key];
      } else {
        const stripped = stripDefaultServerSettings(currentRecord[key], defaultsRecord[key]);
        if (stripped !== undefined) next[key] = stripped;
      }
    }
    return Object.keys(next).length > 0 ? next : undefined;
  }

  return Object.is(current, defaults) ? undefined : current;
}
