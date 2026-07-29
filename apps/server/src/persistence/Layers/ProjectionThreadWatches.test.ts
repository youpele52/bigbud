import { MessageId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ProjectionThreadWatchRepository } from "../Services/ProjectionThreadWatches.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionThreadWatchRepositoryLive } from "./ProjectionThreadWatches.ts";

const layer = it.layer(
  ProjectionThreadWatchRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadWatchRepository", (it) => {
  it.effect("adds one active watch idempotently without replacing other watches", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadWatchRepository;
      const input = {
        watcherThreadId: ThreadId.makeUnsafe("watcher"),
        watchedThreadId: ThreadId.makeUnsafe("watched"),
        watchedThreadTitle: "Watched thread",
        sourceMessageId: MessageId.makeUnsafe("source"),
        createdAt: "2026-07-29T00:00:00.000Z",
      };

      yield* repository.addActiveWatch(input);
      yield* repository.addActiveWatch(input);
      yield* repository.addActiveWatch({
        ...input,
        watchedThreadId: ThreadId.makeUnsafe("watched-2"),
      });

      const watches = yield* repository.listActiveByWatcherAndMessage({
        watcherThreadId: input.watcherThreadId,
        sourceMessageId: input.sourceMessageId,
      });
      assert.equal(watches.length, 2);
      assert.equal(
        watches.filter((watch) => watch.watchedThreadId === input.watchedThreadId).length,
        1,
      );
    }),
  );
});
