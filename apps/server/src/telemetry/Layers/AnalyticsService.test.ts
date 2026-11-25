import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer } from "effect";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { ServerConfig } from "../../startup/config.ts";
import { serverHttpTestLayer } from "../../server.test.http.ts";
import { getTelemetryIdentifier } from "../Identify.ts";
import { AnalyticsService } from "../Services/AnalyticsService.ts";
import { AnalyticsServiceLayerLive } from "./AnalyticsService.ts";

interface RecordedBatchRequest {
  readonly path: string;
  readonly body: {
    readonly api_key?: string;
    readonly batch?: ReadonlyArray<{
      readonly distinct_id?: string;
      readonly event?: string;
      readonly properties?: {
        readonly index?: number;
        readonly clientType?: string;
      };
    }>;
  } | null;
}

interface RecordedBatchBody {
  readonly api_key?: string;
  readonly batch: ReadonlyArray<{
    readonly distinct_id?: string;
    readonly event?: string;
    readonly properties?: {
      readonly index?: number;
      readonly clientType?: string;
    };
  }>;
}

it.layer(NodeServices.layer)("AnalyticsService test", (it) => {
  for (const [name, config] of [
    ["default settings", {}],
    ["disabled with a key", { BIGBUD_TELEMETRY_ENABLED: false, BIGBUD_POSTHOG_KEY: "key" }],
    ["enabled without a key", { BIGBUD_TELEMETRY_ENABLED: true }],
    ["enabled with a blank key", { BIGBUD_TELEMETRY_ENABLED: true, BIGBUD_POSTHOG_KEY: "  " }],
    [
      "legacy variables alone",
      {
        T3CODE_TELEMETRY_ENABLED: true,
        T3CODE_POSTHOG_KEY: "legacy",
        T3CODE_POSTHOG_HOST: "https://example.invalid",
        T3CODE_TELEMETRY_FLUSH_BATCH_SIZE: 1,
        T3CODE_TELEMETRY_MAX_BUFFERED_EVENTS: 1,
      },
    ],
    [
      "legacy key with bigbud opt-in",
      { BIGBUD_TELEMETRY_ENABLED: true, T3CODE_POSTHOG_KEY: "legacy" },
    ],
    [
      "legacy opt-in with bigbud key",
      { T3CODE_TELEMETRY_ENABLED: true, BIGBUD_POSTHOG_KEY: "key" },
    ],
  ] as const) {
    it.effect(`${name} does not create an identifier`, () =>
      Effect.gen(function* () {
        const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
          prefix: "telemetry-disabled-",
        });
        const runtimeLayer = AnalyticsServiceLayerLive.pipe(
          Layer.provideMerge(serverConfigLayer),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
          Layer.provideMerge(serverHttpTestLayer),
        );
        yield* Effect.gen(function* () {
          const analytics = yield* AnalyticsService;
          const { anonymousIdPath } = yield* ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          yield* analytics.record("test.disabled");
          yield* analytics.flush;
          assert.equal(yield* fs.exists(anonymousIdPath), false);
        }).pipe(Effect.provide(runtimeLayer));
      }),
    );
  }

  it.effect("installation identifier is random and persisted", () =>
    Effect.gen(function* () {
      const first = yield* getTelemetryIdentifier;
      const second = yield* getTelemetryIdentifier;
      assert.match(
        first ?? "",
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      assert.equal(first, second);
    }).pipe(Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "telemetry-id-" }))),
  );
  it.effect("flush drains all buffered events across multiple batches", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-base-",
      });

      const telemetryLayer = AnalyticsServiceLayerLive.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          BIGBUD_TELEMETRY_ENABLED: true,
          BIGBUD_POSTHOG_KEY: "phc_test_key",
          BIGBUD_POSTHOG_HOST: "",
          BIGBUD_TELEMETRY_FLUSH_BATCH_SIZE: 20,
          T3CODE_POSTHOG_HOST: "https://example.invalid",
          T3CODE_TELEMETRY_FLUSH_BATCH_SIZE: 1,
          T3CODE_TELEMETRY_MAX_BUFFERED_EVENTS: 1,
        }),
      );
      const batchServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "POST") {
            return HttpServerResponse.empty({ status: 404 });
          }

          const payload = yield* request.json.pipe(
            Effect.map((body) => body as RecordedBatchRequest["body"]),
            Effect.catch(() => Effect.succeed(null)),
          );

          capturedRequests.push({ path: request.url, body: payload });

          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provideMerge(serverHttpTestLayer),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const telemetryIdentifier = yield* getTelemetryIdentifier;
        assert.equal(telemetryIdentifier !== null, true);
        const analytics = yield* AnalyticsService;

        for (let index = 0; index < 45; index += 1) {
          yield* analytics.record("test.flush.drain", { index });
        }

        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      const batchRequests = capturedRequests.filter(
        (request): request is RecordedBatchRequest & { readonly body: RecordedBatchBody } =>
          Array.isArray(request.body?.batch),
      );
      assert.equal(batchRequests.length, 3);
      assert.equal(
        batchRequests.every((request) => request.body.api_key === "phc_test_key"),
        true,
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every((event) =>
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
              event.distinct_id ?? "",
            ),
          ),
        ),
        true,
      );
      assert.equal(
        batchRequests.every((request) => request.path === "/batch/" || request.path === "/batch"),
        true,
      );
      const deliveredIndexes = batchRequests.flatMap((request) =>
        request.body.batch
          .filter((event) => event.event === "test.flush.drain")
          .map((event) => event.properties?.index)
          .filter((index): index is number => typeof index === "number"),
      );

      const sorted = deliveredIndexes.toSorted((a, b) => a - b);
      assert.equal(sorted.length, 45);
      assert.deepEqual(
        sorted,
        Array.from({ length: 45 }, (_, index) => index),
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every((event) => event.properties?.clientType === "cli-web-client"),
        ),
        true,
      );
    }),
  );
});
