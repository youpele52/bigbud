import { it, describe, expect } from "@effect/vitest";
import { Effect, Option, Stream } from "effect";

import { createRemoteDirectoryPollingStream } from "./WorkspaceFileSystem.remoteWatch.ts";

describe("createRemoteDirectoryPollingStream", () => {
  it.effect("emits an invalidation when the remote directory snapshot changes", () =>
    Effect.gen(function* () {
      let reads = 0;
      const stream = createRemoteDirectoryPollingStream({
        cwd: "/remote/project",
        relativePath: "src",
        pollIntervalMs: 10,
        readSnapshot: async () => (reads++ === 0 ? "before" : "after"),
      });

      const event = yield* Stream.runHead(stream);
      expect(Option.isSome(event)).toBe(true);
      if (!Option.isSome(event)) throw new Error("Expected a directory invalidation event.");
      expect(event.value).toEqual({
        version: 1,
        type: "directoryChanged",
        relativePath: "src",
        generation: 1,
      });
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
        },
        {
          version: 1,
          type: "directoryChanged",
          relativePath: "docs",
          generation: 2,
        },
      ]);
    }),
  );
});
