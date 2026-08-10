import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { HttpClient } from "effect/unstable/http";

import { buildAppUnderTest, serverTestLayer } from "./server.test.helpers.ts";

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const pluginId = "openai-public:asana";
const revision = "revision-1";

it.layer(serverTestLayer)("plugin asset route", (it) => {
  it.effect("serves validated logo assets for catalog and installed revisions", () =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const directory = await mkdtemp(join(tmpdir(), "bigbud-plugin-asset-"));
        const imagePath = join(directory, "logo.png");
        const svgPath = join(directory, "temporal-logo.svg");
        await Promise.all([
          writeFile(imagePath, PNG_SIGNATURE),
          writeFile(
            svgPath,
            '<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated artwork -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>',
          ),
        ]);
        return { directory, imagePath, svgPath };
      }),
      ({ imagePath, svgPath }) =>
        Effect.gen(function* () {
          yield* buildAppUnderTest({
            layers: {
              pluginRegistry: {
                resolveAsset: (input) =>
                  Effect.succeed(
                    input.pluginId === "openai-public:temporal" &&
                      input.revision === revision &&
                      input.scope === "catalog" &&
                      input.assetKey === "logo"
                      ? svgPath
                      : input.pluginId === pluginId &&
                          input.revision === revision &&
                          (input.scope === "catalog" || input.scope === "installed") &&
                          (input.assetKey === "logo" || input.assetKey === "logoDark")
                        ? imagePath
                        : undefined,
                  ),
              },
            },
          });
          for (const scope of ["catalog", "installed"] as const) {
            const response = yield* HttpClient.get(
              `/api/plugins/assets?scope=${scope}&revision=${revision}&pluginId=${encodeURIComponent(pluginId)}&assetKey=logo`,
            );
            assert.equal(response.status, 200);
            assert.equal(response.headers["content-type"], "image/png");
          }
          const temporal = yield* HttpClient.get(
            `/api/plugins/assets?scope=catalog&revision=${revision}&pluginId=${encodeURIComponent("openai-public:temporal")}&assetKey=logo`,
          );
          assert.equal(temporal.status, 200);
          assert.equal(temporal.headers["content-type"], "image/svg+xml");
          const traversal = yield* HttpClient.get(
            `/api/plugins/assets?scope=catalog&revision=${revision}&pluginId=${encodeURIComponent(pluginId)}&assetKey=../logo`,
          );
          assert.equal(traversal.status, 400);
        }),
      ({ directory }) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
