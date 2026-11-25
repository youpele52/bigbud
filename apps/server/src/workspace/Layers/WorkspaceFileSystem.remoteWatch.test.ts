import { it, describe, expect } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Stream } from "effect";

import { createRemoteDirectoryPollingStream } from "./WorkspaceFileSystem.remoteWatch.ts";

describe("createRemoteDirectoryPollingStream", () => {
  it.effect("keeps invalidations in order when a slow consumer fills the bounded queue", () =>
    Effect.gen(function* () {
      let reads = 0;
      const stream = createRemoteDirectoryPollingStream({
        cwd: "/remote/project",
        relativePath: "src",
        pollIntervalMs: 10,
        readSnapshot: async () => String(reads++),
      });
      const events = yield* Stream.runCollect(
        stream.pipe(
          Stream.tap(() => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)))),
          Stream.take(14),
        ),
      ).pipe(Effect.timeout("5 seconds"));
      expect(events.map((event) => event.generation)).toEqual(
        Array.from({ length: 14 }, (_, index) => index + 1),
      );
    }),
  );

  it.effect("stops polling when a full watcher is cancelled", () =>
    Effect.gen(function* () {
      let reads = 0;
      const stream = createRemoteDirectoryPollingStream({
        cwd: "/remote/project",
        relativePath: "src",
        pollIntervalMs: 10,
        readSnapshot: async () => String(reads++),
      });
      yield* Stream.runCollect(
        stream.pipe(
          Stream.tap(() =>
            Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 250))),
          ),
          Stream.take(1),
        ),
      ).pipe(Effect.timeout("5 seconds"));
      const afterCancel = reads;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)));
      expect(reads).toBe(afterCancel);
    }),
  );
  it.effect("signals an outstanding snapshot when the subscriber ends", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<AbortSignal>();
      const pending = Promise.withResolvers<string>();
      const stream = createRemoteDirectoryPollingStream({
        cwd: "/remote/project",
        relativePath: "src",
        readSnapshot: (signal) => {
          Deferred.doneUnsafe(started, Effect.succeed(signal));
          return pending.promise;
        },
      });
      const subscriber = yield* Effect.forkScoped(Stream.runDrain(stream));
      const signal = yield* Deferred.await(started);
      expect(signal.aborted).toBe(false);
      yield* Fiber.interrupt(subscriber);
      expect(signal.aborted).toBe(true);
      pending.resolve("late snapshot");
    }).pipe(Effect.timeout("5 seconds")),
  );

  it.effect("emits an invalidation when the remote directory snapshot changes", () =>
    Effect.gen(function* () {
      let reads = 0;
      const stream = createRemoteDirectoryPollingStream({
        cwd: "/remote/project",
        relativePath: "src",
        pollIntervalMs: 10,
        readSnapshot: async () => (reads++ === 0 ? "before" : "after"),
      });

      const event = yield* Stream.runHead(Stream.drop(stream, 1));
      expect(Option.isSome(event)).toBe(true);
      if (!Option.isSome(event)) throw new Error("Expected a directory invalidation event.");
      expect(event.value).toEqual({
        version: 1,
        type: "directoryChanged",
        relativePath: "src",
        generation: 2,
        backend: "directSshPoll",
      });
    }),
  );

  it.effect("invalidates a stale preview after the first SSH snapshot establishes the watch", () =>
    Effect.gen(function* () {
      const stream = createRemoteDirectoryPollingStream({
        cwd: "/remote/project",
        relativePath: "",
        readSnapshot: async () => "already changed before watching",
      });
      const event = yield* Stream.runHead(stream);
      expect(Option.isSome(event)).toBe(true);
      if (!Option.isSome(event)) throw new Error("Expected initial reconciliation.");
      expect(event.value).toMatchObject({ type: "directoryChanged", relativePath: "" });
    }),
  );

  it.effect("requests a rescan once while the SSH transport is unavailable", () =>
    Effect.gen(function* () {
      const stream = createRemoteDirectoryPollingStream({
        cwd: "/remote/project",
        relativePath: "",
        pollIntervalMs: 10,
        readSnapshot: async () => {
          throw new Error("connection lost");
        },
      });

      const event = yield* Stream.runHead(stream);
      expect(Option.isSome(event)).toBe(true);
      if (!Option.isSome(event)) throw new Error("Expected a rescan event.");
      expect(event.value).toEqual({
        version: 1,
        type: "rescanRequired",
        relativePath: "",
        generation: 1,
        reason: "transportLost",
        backend: "directSshPoll",
      });
    }),
  );

  it.effect("invalidates the directory after the SSH transport recovers", () =>
    Effect.gen(function* () {
      let reads = 0;
      const stream = createRemoteDirectoryPollingStream({
        cwd: "/remote/project",
        relativePath: "docs",
        pollIntervalMs: 10,
        readSnapshot: async () => {
          reads += 1;
          if (reads === 1) throw new Error("connection lost");
          return "recovered";
        },
      });

      const events = yield* Stream.runCollect(Stream.take(stream, 2));
      expect([...events]).toEqual([
        {
          version: 1,
          type: "rescanRequired",
          relativePath: "docs",
          generation: 1,
          reason: "transportLost",
          backend: "directSshPoll",
        },
        {
          version: 1,
          type: "directoryChanged",
          relativePath: "docs",
          generation: 2,
          backend: "directSshPoll",
        },
      ]);
    }),
  );
});
