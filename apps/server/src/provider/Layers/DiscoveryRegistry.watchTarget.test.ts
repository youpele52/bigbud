import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Ref, Stream } from "effect";

import { runDiscoveryWatchTarget } from "./DiscoveryRegistry.watch.ts";

// Real file-system regression for the rescan storm: the server watched `~/.pi`
// recursively because `~/.pi/skills` was missing, so every Pi session write rescanned.
const settle = Effect.sleep("600 millis");

const waitForCount = (count: Ref.Ref<number>, minimum: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((yield* Ref.get(count)) >= minimum) return;
      yield* Effect.sleep("50 millis");
    }
    assert.fail(`expected at least ${minimum} change notifications`);
  });

describe("DiscoveryRegistry watch targets on the real file system", () => {
  describe("missing leaf under an active parent", () => {
    it.live("ignores writes elsewhere under the parent, then follows the new leaf", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "disc-watch-pi-" });
          const parent = path.join(home, ".pi");
          const sessions = path.join(parent, "agent", "sessions");
          const leaf = path.join(parent, "skills");
          yield* fs.makeDirectory(sessions, { recursive: true });

          const changes = yield* Ref.make(0);
          yield* runDiscoveryWatchTarget(
            fs,
            { path: leaf, parent },
            Ref.update(changes, (count) => count + 1),
            "50 millis",
          ).pipe(Effect.forkScoped);
          yield* settle;

          for (let write = 0; write < 40; write += 1) {
            yield* fs.writeFileString(path.join(sessions, "session.jsonl"), `entry ${write}\n`);
            yield* Effect.sleep("10 millis");
          }
          yield* settle;
          assert.strictEqual(yield* Ref.get(changes), 0);

          yield* fs.makeDirectory(path.join(leaf, "new-skill"), { recursive: true });
          yield* waitForCount(changes, 1);
          yield* settle;

          const afterAppear = yield* Ref.get(changes);
          // A direct child: Linux watches are non-recursive, so nested writes are not seen.
          yield* fs.makeDirectory(path.join(leaf, "second-skill"));
          yield* waitForCount(changes, afterAppear + 1);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );

    it.live("does not rescan when the watched parent itself is removed", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "disc-watch-gone-" });
          const parent = path.join(home, ".copilot");
          yield* fs.makeDirectory(path.join(parent, "logs"), { recursive: true });

          const changes = yield* Ref.make(0);
          yield* runDiscoveryWatchTarget(
            fs,
            { path: path.join(parent, "agents"), parent },
            Ref.update(changes, (count) => count + 1),
            "50 millis",
          ).pipe(Effect.forkScoped);
          yield* settle;

          yield* fs.remove(parent, { recursive: true });
          yield* settle;
          yield* settle;

          assert.strictEqual(yield* Ref.get(changes), 0);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  describe("re-arming a watch on an existing path", () => {
    const watchExisting = (watchStream: () => Stream.Stream<string, Error>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "disc-watch-rearm-" });
          const changes = yield* Ref.make(0);
          yield* runDiscoveryWatchTarget(
            fs,
            { path: root, parent: null },
            Ref.update(changes, (count) => count + 1),
            "100 millis",
            watchStream,
          ).pipe(Effect.forkScoped);
          yield* Effect.sleep("900 millis");
          return yield* Ref.get(changes);
        }),
      ).pipe(Effect.provide(NodeServices.layer));

    it.live("catches up once per re-arm after a live watch ends", () =>
      Effect.gen(function* () {
        // Silent for 300 ms, then ends, as a watcher dropped by the OS would.
        const changes = yield* watchExisting(() =>
          Stream.fromEffect(Effect.sleep("300 millis")).pipe(Stream.drain),
        );
        assert.isAtLeast(changes, 1);
        assert.isAtMost(changes, 3);
      }),
    );

    it.live("does not rescan for a watch that keeps failing immediately", () =>
      Effect.gen(function* () {
        const changes = yield* watchExisting(() => Stream.fail(new Error("EMFILE")));
        assert.strictEqual(changes, 0);
      }),
    );
  });
});
