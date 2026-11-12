import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { expect, vi } from "vitest";
import { fixture, owner } from "../../persistence/Layers/DirectShellLaunchOwners.test.helpers";
import { makeDirectShellLaunchOwners } from "../../persistence/Layers/DirectShellLaunchOwners";
import { directShellOwnerKey } from "./DirectShellLaunch.owner";
import { historyPath } from "./Manager.history-io";
import { remoteFixture } from "./Manager.shell.remote.test.helpers";
import { FakePtyAdapter, openInput } from "./Manager.test.helpers";

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "durable bulk-close protection",
  (it) => {
    for (const [legacy, live] of [
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ]) {
      it.effect(
        `preserves absent-owner history before touching live sessions (legacy=${legacy}, live=${live})`,
        () =>
          Effect.gen(function* () {
            const db = yield* Effect.promise(fixture);
            const pane = { threadId: "thread-1", terminalId: "default" };
            const saved = {
              ...owner(),
              ownerKey: directShellOwnerKey(pane.threadId, pane.terminalId),
              ...(legacy ? {} : { pane }),
            };
            yield* Effect.promise(() => db.store.reserve(saved));
            yield* Effect.promise(() =>
              db.store.claimDispatch(saved.ownerKey, saved.reservationId, saved.controllerId),
            );
            yield* Effect.promise(() => db.runtime.dispose());
            const reopened = yield* Effect.promise(db.open);
            const store = yield* Effect.promise(() =>
              reopened.runPromise(makeDirectShellLaunchOwners()),
            );
            const adapter = new FakePtyAdapter();
            const release = vi.fn(() => Effect.void);
            const { manager, logsDir } = yield* remoteFixture(
              {
                directShellOwners: store,
                ptyAdapter: adapter,
                releaseWorktreeLease: release,
              },
              "protected remote output",
            );
            const fs = yield* FileSystem.FileSystem;
            if (live) yield* manager.open(openInput({ terminalId: "local", cwd: logsDir }));
            const before = yield* Effect.promise(() => store.get(saved.ownerKey));
            for (let retry = 0; retry < 2; retry++) {
              const result = yield* manager
                .close({ threadId: "thread-1", deleteHistory: true })
                .pipe(Effect.result);
              expect(result._tag).toBe("Failure");
              expect(yield* fs.readFileString(historyPath(logsDir, "thread-1", "default"))).toBe(
                "protected remote output",
              );
              expect(yield* Effect.promise(() => store.get(saved.ownerKey))).toEqual(before);
              expect(adapter.processes.flatMap((process) => process.killSignals)).toEqual([]);
              expect(release).not.toHaveBeenCalled();
            }
          }),
      );
    }

    it.effect("allows another thread's cleanup only with validated owner scope", () =>
      Effect.gen(function* () {
        const db = yield* Effect.promise(fixture);
        const saved = { ...owner(), pane: { threadId: "thread", terminalId: "pane" } };
        yield* Effect.promise(() => db.store.reserve(saved));
        const { manager, logsDir } = yield* remoteFixture(
          { directShellOwners: db.store },
          "local output",
        );
        const fs = yield* FileSystem.FileSystem;
        yield* manager.close({ threadId: "thread-1", deleteHistory: true });
        expect(yield* fs.exists(historyPath(logsDir, "thread-1", "default"))).toBe(false);
        expect(yield* Effect.promise(() => db.store.get(saved.ownerKey))).toEqual(saved);
      }),
    );

    for (const unavailable of ["missing", "failed"] as const) {
      it.effect(`refuses before deleting history when ownership query is ${unavailable}`, () =>
        Effect.gen(function* () {
          const db = yield* Effect.promise(fixture);
          const { hasOwnersForThread: _, ...store } = db.store;
          const { manager, logsDir } = yield* remoteFixture(
            {
              directShellOwners: {
                ...store,
                ...(unavailable === "failed"
                  ? {
                      hasOwnersForThread: async () => {
                        throw new Error("unavailable");
                      },
                    }
                  : {}),
              },
            },
            "retained output",
          );
          const result = yield* manager
            .close({ threadId: "thread-1", deleteHistory: true })
            .pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          const fs = yield* FileSystem.FileSystem;
          expect(yield* fs.readFileString(historyPath(logsDir, "thread-1", "default"))).toBe(
            "retained output",
          );
        }),
      );
    }
  },
);
