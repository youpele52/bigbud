import type { GitStatusStreamEvent } from "@bigbud/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { GitCore, type GitCoreShape, type GitStatusDetails } from "../Services/GitCore.ts";
import {
  GIT_STATUS_RETAINED_REMOTE_CWD_CAPACITY,
  makeGitStatusBroadcaster,
} from "./GitStatusBroadcaster.ts";

function makeGitCore(calls: { local: number }) {
  const details = (): GitStatusDetails =>
    ({
      isRepo: true,
      hasOriginRemote: true,
      isDefaultBranch: true,
      branch: "main",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      upstreamRef: null,
    }) as GitStatusDetails;
  return Layer.succeed(GitCore, {
    statusDetailsLocal: () => Effect.sync(() => (calls.local++, details())),
    statusDetails: () => Effect.sync(details),
  } as unknown as GitCoreShape);
}

describe("GitStatusBroadcaster per-cwd entries", () => {
  it("removes a cwd's entry when its last subscriber leaves and keeps remote status bounded", async () => {
    const calls = { local: 0 };
    const program = Effect.gen(function* () {
      const broadcaster = yield* makeGitStatusBroadcaster();
      const cwds = Array.from({ length: 300 }, (_, index) => `/repo-${index}`);

      for (const cwd of cwds) {
        yield* broadcaster.invalidateRemote(cwd);
        const stream = yield* broadcaster.subscribe(cwd);
        // Take the snapshot, then stay subscribed until interrupted.
        const fiber = yield* Stream.runDrain(stream).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(broadcaster.activeCwdCount()).toBe(1);
        yield* Fiber.interrupt(fiber);
      }
      expect(broadcaster.activeCwdCount()).toBe(0);

      // No subscribers: an invalidation runs no git command and creates no entry.
      const before = calls.local;
      yield* broadcaster.invalidateLocal("/repo-299");
      expect(calls.local).toBe(before);
      expect(broadcaster.activeCwdCount()).toBe(0);

      // A returning subscriber still sees the retained remote status in its snapshot;
      // the oldest cwds beyond the retention capacity fell out.
      const first = (cwd: string) =>
        broadcaster
          .subscribe(cwd)
          .pipe(Effect.flatMap((stream) => Stream.runHead(Stream.take(stream, 1))));
      const recent = (yield* first("/repo-299")) as { value: GitStatusStreamEvent };
      expect(recent.value).toMatchObject({ _tag: "snapshot", remote: { aheadCount: 2 } });
      const evicted = (yield* first(
        `/repo-${300 - GIT_STATUS_RETAINED_REMOTE_CWD_CAPACITY - 1}`,
      )) as {
        value: GitStatusStreamEvent;
      };
      expect(evicted.value).toMatchObject({ _tag: "snapshot", remote: null });
      expect(broadcaster.activeCwdCount()).toBe(0);
    });
    await Effect.runPromise(program.pipe(Effect.provide(makeGitCore(calls))));
  });
});
