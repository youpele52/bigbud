import type { GitStatusStreamEvent } from "@bigbud/contracts";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { GitCore, type GitCoreShape, type GitStatusDetails } from "../Services/GitCore.ts";
import { GitStatusBroadcaster } from "../Services/GitStatusBroadcaster.ts";
import {
  GIT_STATUS_SUBSCRIBER_BACKLOG_CAPACITY,
  GitStatusBroadcasterLive,
} from "./GitStatusBroadcaster.ts";

const PUBLISHED_UPDATES = GIT_STATUS_SUBSCRIBER_BACKLOG_CAPACITY * 4;

function makeGitCore() {
  let calls = 0;
  const details = (): GitStatusDetails => {
    calls += 1;
    return {
      isRepo: true,
      hasOriginRemote: false,
      isDefaultBranch: true,
      branch: `branch-${calls}`,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      upstreamRef: null,
    } as GitStatusDetails;
  };
  return Layer.succeed(GitCore, {
    statusDetailsLocal: () => Effect.sync(details),
    statusDetails: () => Effect.sync(details),
  } as unknown as GitCoreShape);
}

const branchOf = (event: GitStatusStreamEvent): string | null =>
  event._tag === "remoteUpdated" ? null : event.local.branch;

describe("GitStatusBroadcaster slow subscriber backlog", () => {
  it("keeps at most the backlog capacity for a subscriber that does not read", async () => {
    const program = Effect.gen(function* () {
      const broadcaster = yield* GitStatusBroadcaster;
      const stream = yield* broadcaster.subscribe("/repo");
      const pull = yield* Stream.toPull(stream);
      const received: GitStatusStreamEvent[] = [];
      const takeAvailable = Effect.gen(function* () {
        while (true) {
          const next = yield* pull.pipe(
            Effect.map(Option.some),
            Effect.timeoutOption("50 millis"),
            Effect.map(Option.flatten),
            Effect.catch(() => Effect.succeed(Option.none())),
          );
          if (Option.isNone(next)) return;
          received.push(...next.value);
        }
      });
      received.push(...(yield* pull));
      // A pending pull past the snapshot subscribes the live stream to the PubSub.
      const pending = yield* Effect.forkChild(pull);
      yield* Effect.sleep("20 millis");
      for (let index = 0; index < PUBLISHED_UPDATES; index += 1) {
        yield* broadcaster.invalidateLocal("/repo");
      }
      received.push(...(yield* Fiber.join(pending)));
      yield* takeAvailable;
      return received;
    });

    const received = await Effect.runPromise(
      Effect.scoped(program).pipe(
        Effect.provide(GitStatusBroadcasterLive.pipe(Layer.provide(makeGitCore()))),
      ),
    );

    const live = received.filter((event) => event._tag === "localUpdated");
    expect(received[0]?._tag).toBe("snapshot");
    expect(live.length).toBeGreaterThan(0);
    // One event can be in flight to the waiting pull; the rest is the bounded backlog.
    expect(live.length).toBeLessThanOrEqual(GIT_STATUS_SUBSCRIBER_BACKLOG_CAPACITY + 1);
    // Sliding keeps the newest state: the last update the subscriber sees is the last published.
    expect(branchOf(live.at(-1)!)).toBe(`branch-${PUBLISHED_UPDATES + 1}`);
  });
});
