import { Effect, Layer } from "effect";
import { expect, it } from "vitest";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { MuseSessionBindingsLive } from "./MuseSessionBindings.ts";
import { MuseSessionBindings } from "../Services/MuseSessionBindings.ts";

const material = {
  threadId: "thread-muse-1",
  nativeSessionId: "0199-native-session",
  creationCommandId: "0199-creation-command",
  workspace: "/workspace",
  storageIdentity: "/muse-home",
  selectionFingerprint: "model-and-policy-digest",
  createdAt: "2026-10-29T00:00:00.000Z",
};

const layer = Layer.provideMerge(MuseSessionBindingsLive, SqlitePersistenceMemory);

it("reserves immutably, binds once after exact-ID confirmation, and never replaces material", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const repo = yield* MuseSessionBindings;
      const reserved = yield* repo.reserve(material);
      expect(reserved.phase).toBe("reserved");
      expect(yield* repo.reserve(material)).toEqual(reserved);
      expect(
        yield* Effect.result(repo.reserve({ ...material, nativeSessionId: "different" })),
      ).toMatchObject({ _tag: "Failure" });
      const bound = yield* repo.transition(reserved, "bound");
      expect(bound.phase).toBe("bound");
      expect(bound.revision).toBe(1);
      // Terminal phases never reopen, and stale CAS fences lose.
      expect(yield* Effect.result(repo.transition(bound, "blocked"))).toMatchObject({
        _tag: "Failure",
      });
      expect(yield* Effect.result(repo.transition(reserved, "bound"))).toMatchObject({
        _tag: "Failure",
      });
      expect(yield* repo.find(material.threadId)).toEqual(bound);
    }).pipe(Effect.provide(layer)),
  );
});

it("blocked bindings stay blocked so uncertain creation cannot be retried as a new session", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const repo = yield* MuseSessionBindings;
      const reserved = yield* repo.reserve({ ...material, threadId: "thread-muse-2" });
      const blocked = yield* repo.transition(reserved, "blocked");
      expect(blocked.phase).toBe("blocked");
      expect(yield* repo.reserve({ ...material, threadId: "thread-muse-2" })).toEqual(blocked);
    }).pipe(Effect.provide(layer)),
  );
});
