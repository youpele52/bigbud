import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vitest";
import { fixture, owner } from "../../persistence/Layers/DirectShellLaunchOwners.test.helpers";
import { directShellOwnerKey } from "./DirectShellLaunch.owner";
import { remoteFixture } from "./Manager.shell.remote.test.helpers";

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "forgetting unverifiable direct shell records",
  (it) => {
    it.effect("forgets only the blocked thread's records, after which its cleanup succeeds", () =>
      Effect.gen(function* () {
        const db = yield* Effect.promise(fixture);
        // A legacy record for thread-1's pane, one scoped to another thread, and an unrelated one.
        const legacy = { ...owner("legacy"), ownerKey: directShellOwnerKey("thread-1", "default") };
        const otherThread = {
          ...owner("other-thread"),
          ownerKey: directShellOwnerKey("thread-2", "pane"),
          pane: { threadId: "thread-2", terminalId: "pane" },
        };
        const unrelatedLegacy = {
          ...owner("unrelated"),
          ownerKey: directShellOwnerKey("thread-3", "x"),
        };
        for (const saved of [legacy, otherThread, unrelatedLegacy]) {
          yield* Effect.promise(() => db.store.reserve(saved));
        }
        const { manager } = yield* remoteFixture({ directShellOwners: db.store }, "remote output");

        const blocked = yield* manager
          .close({ threadId: "thread-1", deleteHistory: true })
          .pipe(Effect.result);
        expect(blocked._tag).toBe("Failure");
        const retained = yield* manager.retainedShellOwners!({ threadId: "thread-1" });
        expect(retained.count).toBe(1);
        expect(retained.hosts).toEqual(["example.test"]);

        expect(yield* manager.forgetRetainedShellOwners!({ threadId: "thread-1" })).toEqual({
          forgotten: 1,
        });
        expect(yield* Effect.promise(() => db.store.get(legacy.ownerKey))).toBeUndefined();
        expect(yield* Effect.promise(() => db.store.get(otherThread.ownerKey))).toEqual(
          otherThread,
        );
        expect(yield* Effect.promise(() => db.store.get(unrelatedLegacy.ownerKey))).toEqual(
          unrelatedLegacy,
        );
        yield* manager.close({ threadId: "thread-1", deleteHistory: true });
        expect(yield* manager.retainedShellOwners!({ threadId: "thread-1" })).toEqual({
          hosts: [],
          count: 0,
        });
      }),
    );
  },
);
