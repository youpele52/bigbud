import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type OrchestrationReadModel } from "@bigbud/contracts";
import { Effect, FileSystem, Layer, Ref, Stream } from "effect";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerConfig } from "./config.ts";
import { runLegacyPinnedThreadSettingsMigration } from "./LegacyPinnedThreadSettingsMigration.ts";

interface MigrationThread {
  readonly id: ThreadId;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly deletingAt: string | null;
  readonly pinnedAt: string | null;
}

interface MigrationState {
  readonly threads: ReadonlyArray<MigrationThread>;
}

const makeMigrationEngine = (initialState: MigrationState) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(initialState);
    const dispatchCount = yield* Ref.make(0);

    return {
      getReadModel: () =>
        Ref.get(state).pipe(Effect.map((value) => value as OrchestrationReadModel)),
      readEvents: () => Stream.empty,
      readReplay: () => Effect.die("unused"),
      dispatch: (command) =>
        Effect.gen(function* () {
          if (command.type !== "thread.pin.migrate") {
            return yield* Effect.die(`Unexpected command '${command.type}'.`);
          }
          yield* Ref.update(dispatchCount, (count) => count + 1);
          yield* Ref.update(state, (current) => ({
            ...current,
            threads: current.threads.map((thread) =>
              thread.id === command.threadId ? { ...thread, pinnedAt: command.pinnedAt } : thread,
            ),
          }));
          return { sequence: 1 };
        }),
      streamDomainEvents: Stream.empty,
      state,
      dispatchCount,
    } satisfies OrchestrationEngineShape & {
      readonly state: Ref.Ref<MigrationState>;
      readonly dispatchCount: Ref.Ref<number>;
    };
  });

const legacyPinsMigrationLayer = Layer.mergeAll(
  NodeServices.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-legacy-pins-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  Layer.effect(
    OrchestrationEngineService,
    makeMigrationEngine({
      threads: [
        {
          id: ThreadId.makeUnsafe("thread-newest"),
          archivedAt: null,
          deletedAt: null,
          deletingAt: null,
          pinnedAt: null,
        },
        {
          id: ThreadId.makeUnsafe("thread-oldest"),
          archivedAt: null,
          deletedAt: null,
          deletingAt: null,
          pinnedAt: null,
        },
      ],
    }).pipe(Effect.map(({ dispatchCount: _dispatchCount, state: _state, ...engine }) => engine)),
  ),
);

it.effect("imports legacy pins once without retaining the settings field", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const engine = yield* OrchestrationEngineService;
    yield* fs.writeFileString(
      config.settingsPath,
      JSON.stringify({ favoriteThreadIds: ["thread-newest", "thread-oldest"] }),
    );

    yield* runLegacyPinnedThreadSettingsMigration();

    const firstMigration = yield* engine.getReadModel();
    const newest = firstMigration.threads.find((thread) => thread.id === "thread-newest");
    const oldest = firstMigration.threads.find((thread) => thread.id === "thread-oldest");
    assert.isNotNull(newest?.pinnedAt ?? null);
    assert.isNotNull(oldest?.pinnedAt ?? null);
    assert.isTrue((newest?.pinnedAt ?? "") > (oldest?.pinnedAt ?? ""));
    assert.deepEqual(JSON.parse(yield* fs.readFileString(config.settingsPath)), {});

    yield* runLegacyPinnedThreadSettingsMigration();
    const secondMigration = yield* engine.getReadModel();
    assert.deepEqual(secondMigration.threads, firstMigration.threads);
  }).pipe(Effect.provide(legacyPinsMigrationLayer)),
);
