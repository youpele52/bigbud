import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerProvider } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, PubSub, Ref, Stream } from "effect";

import { makeManagedServerProvider } from "./makeManagedServerProvider";

const model = (slug: string, group: string) => ({
  slug,
  name: slug,
  isCustom: false,
  group,
  capabilities: null,
});

const snapshot = (models: ServerProvider["models"], checkedAt: string): ServerProvider => ({
  provider: "opencode",
  enabled: true,
  installed: true,
  version: "1.17.18",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt,
  models,
  slashCommands: [],
  skills: [],
});

describe("makeManagedServerProvider startup catalog hydration", () => {
  it.layer(NodeServices.layer)("successful startup preflight", (it) => {
    it.effect("immediately replaces fallback models with the full discovered catalog", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const startupProbes = yield* Ref.make(0);
          const fullProbes = yield* Ref.make(0);
          const fallback = snapshot(
            [
              model("claude-sonnet-4-6", "Anthropic"),
              model("claude-haiku-4-5", "Anthropic"),
              model("claude-opus-4-6", "Anthropic"),
            ],
            "2026-08-11T10:00:00.000Z",
          );
          const discovered = snapshot(
            [...fallback.models, model("gpt-5", "OpenAI"), model("gemini-2.5-pro", "Google")],
            "2026-08-11T10:00:01.000Z",
          );

          const service = yield* makeManagedServerProvider({
            getSettings: Effect.succeed({ binaryPath: "opencode" }),
            streamSettings: Stream.empty,
            haveSettingsChanged: () => false,
            checkProviderAtStartup: Ref.update(startupProbes, (count) => count + 1).pipe(
              Effect.as(fallback),
            ),
            checkProvider: Ref.update(fullProbes, (count) => count + 1).pipe(Effect.as(discovered)),
            initialSnapshot: fallback,
            refreshInterval: "1 hour",
          });

          for (let index = 0; index < 10 && (yield* Ref.get(fullProbes)) === 0; index += 1) {
            yield* Effect.yieldNow;
          }

          assert.strictEqual(yield* Ref.get(startupProbes), 1);
          assert.strictEqual(yield* Ref.get(fullProbes), 1);
          assert.deepStrictEqual(
            (yield* service.getSnapshot).models.map(({ slug, group }) => ({ slug, group })),
            discovered.models.map(({ slug, group }) => ({ slug, group })),
          );
        }),
      ),
    );
  });

  it.layer(NodeServices.layer)("decoupled startup enrichment", (it) => {
    it.effect("publishes readiness without waiting for the full model catalog", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const catalog = yield* Deferred.make<ServerProvider>();
          const fallback = snapshot(
            [model("claude-sonnet-4-6", "Anthropic")],
            "2026-08-11T10:00:00.000Z",
          );
          const discovered = snapshot(
            [...fallback.models, model("gpt-5", "OpenAI")],
            "2026-08-11T10:00:01.000Z",
          );
          const service = yield* makeManagedServerProvider({
            getSettings: Effect.succeed({ binaryPath: "opencode" }),
            streamSettings: Stream.empty,
            haveSettingsChanged: () => false,
            checkProvider: Effect.succeed(fallback),
            checkProviderAtStartup: Effect.succeed(fallback),
            initialSnapshot: { ...fallback, status: "warning" },
            enrichSnapshot: ({ publishSnapshot }) =>
              Deferred.await(catalog).pipe(Effect.flatMap(publishSnapshot)),
            preserveEnrichedSnapshot: true,
            refreshInterval: "1 hour",
          });

          yield* Effect.yieldNow;
          assert.strictEqual((yield* service.getSnapshot).status, "ready");
          assert.deepStrictEqual(
            (yield* service.getSnapshot).models.map((entry) => entry.slug),
            ["claude-sonnet-4-6"],
          );

          yield* Deferred.succeed(catalog, discovered);
          yield* Effect.yieldNow;
          assert.deepStrictEqual(
            (yield* service.getSnapshot).models.map((entry) => entry.slug),
            ["claude-sonnet-4-6", "gpt-5"],
          );
        }),
      ),
    );

    it.effect("reuses the enriched catalog across repeated snapshot reads", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const enrichments = yield* Ref.make(0);
          const fallback = snapshot([model("fallback", "Fallback")], "2026-08-11T10:00:00.000Z");
          const discovered = snapshot(
            [model("cached-live-model", "OpenCode Zen")],
            "2026-08-11T10:00:01.000Z",
          );
          const service = yield* makeManagedServerProvider({
            getSettings: Effect.succeed({ binaryPath: "opencode" }),
            streamSettings: Stream.empty,
            haveSettingsChanged: () => false,
            checkProvider: Effect.succeed(fallback),
            initialSnapshot: { ...fallback, status: "warning" },
            enrichSnapshot: ({ publishSnapshot }) =>
              Ref.update(enrichments, (count) => count + 1).pipe(
                Effect.andThen(publishSnapshot(discovered)),
              ),
            preserveEnrichedSnapshot: true,
            refreshInterval: "1 hour",
          });

          for (let index = 0; index < 10 && (yield* Ref.get(enrichments)) === 0; index += 1) {
            yield* Effect.yieldNow;
          }
          for (let index = 0; index < 19; index += 1) {
            assert.deepStrictEqual(
              (yield* service.getSnapshot).models.map((entry) => entry.slug),
              ["cached-live-model"],
            );
          }
          assert.strictEqual(yield* Ref.get(enrichments), 1);
        }),
      ),
    );

    it.effect("ignores catalog enrichment from superseded provider settings", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const settings = yield* Ref.make({ binaryPath: "old" });
          const settingsChanges = yield* PubSub.unbounded<{ readonly binaryPath: string }>();
          const oldCatalog = yield* Deferred.make<ServerProvider>();
          const enrichments = yield* Ref.make(0);
          const fallback = snapshot(
            [model("claude-sonnet-4-6", "Anthropic")],
            "2026-08-11T10:00:00.000Z",
          );
          const stale = snapshot([model("old-model", "Old")], "2026-08-11T10:00:01.000Z");
          const current = snapshot([model("new-model", "New")], "2026-08-11T10:00:02.000Z");
          const service = yield* makeManagedServerProvider({
            getSettings: Ref.get(settings),
            streamSettings: Stream.fromPubSub(settingsChanges),
            haveSettingsChanged: (previous, next) => previous.binaryPath !== next.binaryPath,
            checkProvider: Effect.succeed(fallback),
            initialSnapshot: { ...fallback, status: "warning" },
            enrichSnapshot: ({ publishSnapshot }) =>
              Ref.updateAndGet(enrichments, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count === 1
                    ? Deferred.await(oldCatalog).pipe(Effect.flatMap(publishSnapshot))
                    : publishSnapshot(current),
                ),
              ),
            preserveEnrichedSnapshot: true,
            refreshInterval: "1 hour",
          });

          for (let index = 0; index < 10 && (yield* Ref.get(enrichments)) < 1; index += 1) {
            yield* Effect.yieldNow;
          }
          const nextSettings = { binaryPath: "new" };
          yield* Ref.set(settings, nextSettings);
          yield* PubSub.publish(settingsChanges, nextSettings);
          for (let index = 0; index < 10 && (yield* Ref.get(enrichments)) < 2; index += 1) {
            yield* Effect.yieldNow;
          }
          yield* Deferred.succeed(oldCatalog, stale);
          yield* Effect.yieldNow;

          assert.deepStrictEqual(
            (yield* service.getSnapshot).models.map((entry) => entry.slug),
            ["new-model"],
          );
        }),
      ),
    );
  });
});
