import type { ServerProvider } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref } from "effect";

import { enrichManagedServerCatalog, resolveManagedServerCatalog } from "./managedServerCatalog";

const snapshot = (provider: "kilocode" | "opencode" = "opencode"): ServerProvider => ({
  provider,
  enabled: true,
  installed: true,
  version: "1.17.18",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-11T12:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

const emptyCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
} as const;

describe("managed server catalog", () => {
  it("maps every sub-provider model while retaining routing identity", () => {
    const result = resolveManagedServerCatalog({
      provider: "opencode",
      providers: [
        {
          name: "openai",
          models: {
            gpt: {
              id: "gpt-5",
              providerID: "openai",
              name: "GPT-5",
              capabilities: { reasoning: true },
            },
          },
        },
        {
          name: "Google",
          models: {
            gemini: { id: "gemini-2.5-pro", providerID: "google", name: "Gemini 2.5 Pro" },
          },
        },
      ],
      customModels: ["custom/model"],
      builtInModels: [],
      emptyCapabilities,
    });

    assert.isTrue(result.configured);
    assert.deepStrictEqual(
      result.models.map(({ slug, group, subProviderID }) => ({ slug, group, subProviderID })),
      [
        { slug: "gpt-5", group: "OpenAI", subProviderID: "openai" },
        { slug: "gemini-2.5-pro", group: "Google", subProviderID: "google" },
        { slug: "custom/model", group: undefined, subProviderID: undefined },
      ],
    );
  });

  it.effect("keeps healthy readiness while representing a transient catalog failure", () =>
    Effect.gen(function* () {
      const published = yield* Ref.make<ServerProvider | null>(null);
      yield* enrichManagedServerCatalog({
        provider: "opencode",
        baseSnapshot: snapshot(),
        catalogSnapshot: Effect.succeed({
          ...snapshot(),
          status: "error",
          failure: { classification: "retryable", reason: "connection-refused" },
        }),
        publishSnapshot: (next) => Ref.set(published, next),
      });

      const result = yield* Ref.get(published);
      assert.strictEqual(result?.status, "ready");
      assert.strictEqual(result?.failure, undefined);
      assert.strictEqual(result?.modelDiscovery?.status, "unavailable");
    }),
  );

  it.effect("shares the aggregate cap of three with catalog executions", () =>
    Effect.gen(function* () {
      const active = yield* Ref.make(0);
      const peak = yield* Ref.make(0);
      const release = yield* Deferred.make<void>();
      const run = (provider: "kilocode" | "opencode") =>
        enrichManagedServerCatalog({
          provider,
          baseSnapshot: snapshot(provider),
          catalogSnapshot: Ref.updateAndGet(active, (count) => count + 1).pipe(
            Effect.tap((count) => Ref.update(peak, (current) => Math.max(current, count))),
            Effect.andThen(Deferred.await(release)),
            Effect.ensuring(Ref.update(active, (count) => count - 1)),
            Effect.as(snapshot(provider)),
          ),
          publishSnapshot: () => Effect.void,
        });

      const fiber = yield* Effect.all(
        [run("opencode"), run("kilocode"), run("opencode"), run("kilocode")],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Ref.get(peak), 3);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
    }),
  );
});
