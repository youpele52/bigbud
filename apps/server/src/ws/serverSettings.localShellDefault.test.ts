import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../startup/config";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings";

const layer = ServerSettingsLive.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-local-default-" })),
  Layer.provideMerge(NodeServices.layer),
);
it.effect("local-only update preserves other host choices and suggestion policy atomically", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    yield* settings.start;
    yield* settings.updateSettings({
      terminalShells: {
        hostDefaults: {
          local: { kind: "legacy-auto" },
          remote: { kind: "profile", profileId: "remote-profile" },
        },
        suggestionPolicy: "qualified-history",
      },
    });
    const updated = yield* settings.updateSettings({
      terminalShells: { localDefault: { kind: "profile", profileId: "local-profile" } },
    });
    expect(updated.terminalShells).toEqual({
      version: 1,
      origin: "explicit",
      hostDefaults: {
        local: { kind: "profile", profileId: "local-profile" },
        remote: { kind: "profile", profileId: "remote-profile" },
      },
      suggestionPolicy: "qualified-history",
    });
    const automatic = yield* settings.updateSettings({
      terminalShells: { localDefault: { kind: "legacy-auto" } },
    });
    expect(automatic.terminalShells.hostDefaults.remote).toEqual({
      kind: "profile",
      profileId: "remote-profile",
    });
    expect(automatic.terminalShells.hostDefaults.local).toEqual({ kind: "legacy-auto" });
  }).pipe(Effect.provide(layer), Effect.scoped),
);
