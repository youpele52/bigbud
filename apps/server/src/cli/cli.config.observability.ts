import { parsePersistedServerObservabilitySettings } from "@bigbud/shared/serverSettings";
import { Effect, FileSystem } from "effect";

export const loadPersistedObservabilitySettings = Effect.fn("loadPersistedObservabilitySettings")(
  function* (settingsPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(settingsPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
    const raw = yield* fs.readFileString(settingsPath).pipe(Effect.orElseSucceed(() => ""));
    return parsePersistedServerObservabilitySettings(raw);
  },
);
