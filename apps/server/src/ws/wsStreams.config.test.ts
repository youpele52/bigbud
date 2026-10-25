import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/settings";
import type { ServerConfig } from "@bigbud/contracts/server/server";
import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, PubSub, Ref, Stream } from "effect";

import { makeServerConfigUpdateStream } from "./wsStreams";

const checking: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "warning",
    message: "Checking Codex availability...",
    auth: { status: "unknown" },
    checkedAt: "2026-09-30T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  },
];
const ready: ReadonlyArray<ServerProvider> = checking.map((provider) => ({
  ...provider,
  status: "ready",
  message: undefined,
  auth: { status: "authenticated" },
}));

function config(providers: ReadonlyArray<ServerProvider>): ServerConfig {
  return {
    cwd: "/workspace",
    storage: { notesDir: "/workspace/notes", kanbanDir: "/workspace/kanban" },
    keybindingsConfigPath: "/workspace/keybindings.json",
    keybindings: [],
    issues: [],
    providers,
    discovery: { agents: [], skills: [] },
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/workspace/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  };
}

const makeHarness = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<ReadonlyArray<ServerProvider>>();
  const providers = yield* Ref.make(checking);
  const getProviders = Ref.get(providers);
  return {
    changes,
    publish: (next: ReadonlyArray<ServerProvider>) =>
      Ref.set(providers, next).pipe(Effect.andThen(PubSub.publish(changes, next))),
    input: {
      loadServerConfig: getProviders.pipe(Effect.map(config)),
      providerRegistry: {
        getProviders,
        openChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      },
      keybindings: { streamChanges: Stream.never },
      discoveryRegistry: { streamChanges: Stream.never },
      serverSettings: { streamChanges: Stream.never },
    },
  };
});

it.effect(
  "delivers ready published during snapshot loading, snapshot first, without another event",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const stream = yield* makeServerConfigUpdateStream({
        ...harness.input,
        loadServerConfig: harness.input.loadServerConfig.pipe(
          Effect.tap(() => harness.publish(ready)),
        ),
      });
      const events = yield* Stream.runCollect(Stream.take(stream, 2));
      assert.deepEqual(events, [
        { version: 1, type: "snapshot", config: config(checking) },
        { version: 1, type: "providerStatuses", payload: { providers: ready } },
      ]);
    }),
);

it.effect("retains updates between stream construction and consumption", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const stream = yield* makeServerConfigUpdateStream(harness.input);
    yield* harness.publish(ready);
    const events = yield* Stream.runCollect(Stream.take(stream, 2));
    assert.deepEqual(events, [
      { version: 1, type: "snapshot", config: config(checking) },
      { version: 1, type: "providerStatuses", payload: { providers: ready } },
    ]);
  }),
);

it.effect("does not roll a ready snapshot back with older buffered checking payloads", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const stream = yield* makeServerConfigUpdateStream({
      ...harness.input,
      loadServerConfig: Effect.gen(function* () {
        yield* harness.publish(checking);
        yield* harness.publish(ready);
        return config(ready);
      }),
    });
    const events = yield* Stream.runCollect(Stream.take(stream, 3));
    assert.deepEqual(events, [
      { version: 1, type: "snapshot", config: config(ready) },
      { version: 1, type: "providerStatuses", payload: { providers: ready } },
      { version: 1, type: "providerStatuses", payload: { providers: ready } },
    ]);
  }),
);

it.effect("releases the subscription when the RPC stream is interrupted", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const snapshotSeen = yield* Deferred.make<void>();
    const fiber = yield* Stream.unwrap(makeServerConfigUpdateStream(harness.input)).pipe(
      Stream.runForEach(() => Deferred.succeed(snapshotSeen, undefined)),
      Effect.forkScoped,
    );
    yield* Deferred.await(snapshotSeen);
    yield* Fiber.interrupt(fiber);
    yield* harness.publish(ready);
    assert.equal(yield* PubSub.size(harness.changes), 0);
  }),
);

it.effect("releases the subscription when snapshot acquisition fails", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Stream.unwrap(
      makeServerConfigUpdateStream({
        ...harness.input,
        loadServerConfig: Effect.die("snapshot failed"),
      }),
    ).pipe(Stream.runDrain, Effect.exit);
    yield* harness.publish(ready);
    assert.equal(yield* PubSub.size(harness.changes), 0);
  }),
);
