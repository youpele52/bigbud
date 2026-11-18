import {
  DEFAULT_SERVER_SETTINGS,
  PersistedModelSelection,
  PROVIDER_KINDS,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsPatch,
} from "@bigbud/contracts";
import { deepMerge } from "@bigbud/shared/Struct";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { normalizeTerminalShellSettingsPatch } from "./serverSettings.terminalShells.ts";

export const normalizeServerSettingsPatch = Effect.fn("normalizeServerSettingsPatch")(function* (
  current: ServerSettings,
  patch: ServerSettingsPatch,
) {
  if (Object.prototype.hasOwnProperty.call(patch, "threadRetentionPolicy")) {
    return yield* new ServerSettingsError({
      settingsPath: "<memory>",
      detail: "threadRetentionPolicy must be changed through the dedicated retention RPC",
    });
  }
  const merged = {
    ...deepMerge(current, patch),
    terminalShells: normalizeTerminalShellSettingsPatch(
      current.terminalShells,
      patch.terminalShells,
    ),
  };
  const currentSelection = current.textGenerationModelSelection as unknown;
  const preservePersistedSelection =
    patch.textGenerationModelSelection === undefined &&
    Schema.is(PersistedModelSelection)(currentSelection) &&
    !PROVIDER_KINDS.includes(currentSelection.provider as (typeof PROVIDER_KINDS)[number]);
  const candidate = preservePersistedSelection
    ? {
        ...merged,
        textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
      }
    : merged;
  const decoded = yield* Schema.decodeEffect(ServerSettings)(candidate).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath: "<memory>",
          detail: `failed to normalize server settings: ${SchemaIssue.makeFormatterDefault()(cause.issue)}`,
          cause,
        }),
    ),
  );
  return preservePersistedSelection
    ? ({ ...decoded, textGenerationModelSelection: currentSelection } as ServerSettings)
    : decoded;
});
