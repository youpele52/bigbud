import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer } from "effect";
import { expect, it } from "vitest";
import { ServerConfig } from "../startup/config.ts";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings.ts";
import { V2ConsentAuthority } from "../provider/Layers/OpencodeV2/Application.consent.ts";

it("validated external settings reload revokes the backend permit without relying on an async settings stream", async () => {
  const layer = ServerSettingsLive.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "v2-consent-watcher-" })),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { settingsPath } = yield* ServerConfig;
        const settings = yield* ServerSettingsService;
        yield* settings.start;
        yield* settings.updateSettings({
          providers: {
            opencodeV2: {
              enabled: true,
              connectionMode: "shared",
              nativeServiceTrust: "host-user-v1",
              serviceFile: "/fixture/service.json",
            },
          },
        });
        const authority = new V2ConsentAuthority(settings);
        const old = authority.capture();
        try {
          yield* fs.writeFileString(
            settingsPath,
            JSON.stringify({
              providers: {
                opencodeV2: {
                  enabled: true,
                  connectionMode: "shared",
                  nativeServiceTrust: null,
                  serviceFile: "/fixture/service.json",
                },
              },
            }),
          );
          yield* Effect.promise(() =>
            expect.poll(() => old.signal.aborted, { timeout: 5000 }).toBe(true),
          );
          expect(
            settings.currentSnapshot?.()?.settings.providers.opencodeV2.nativeServiceTrust,
          ).toBeNull();
          expect(() => authority.capture()).toThrow("consent");
          yield* settings.updateSettings({
            providers: { opencodeV2: { nativeServiceTrust: "host-user-v1" } },
          });
          expect(() => old.assertCurrent()).toThrow("revision");
          const next = authority.capture();
          expect(() => next.assertCurrent()).not.toThrow();
          next.release();
        } finally {
          old.release();
          authority.close();
        }
      }),
    ).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
}, 10000);
