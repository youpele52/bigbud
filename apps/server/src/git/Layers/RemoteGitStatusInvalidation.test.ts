import { Effect, Fiber, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { makeRemoteGitStatusInvalidation } from "./RemoteGitStatusInvalidation.ts";

describe("RemoteGitStatusInvalidation", () => {
  it("notifies only subscribers for the matching cwd and execution target", async () => {
    const event = await Effect.runPromise(
      Effect.gen(function* () {
        const invalidation = yield* makeRemoteGitStatusInvalidation;
        const subscription = yield* invalidation
          .changes({ cwd: "/srv/project", executionTargetId: "ssh:one" })
          .pipe(Stream.runHead, Effect.forkChild);

        yield* Effect.yieldNow;
        yield* invalidation.invalidate({
          cwd: "/srv/other",
          executionTargetId: "ssh:one",
        });
        yield* invalidation.invalidate({
          cwd: "/srv/project",
          executionTargetId: "ssh:two",
        });
        yield* invalidation.invalidate({
          cwd: "/srv/project",
          executionTargetId: "ssh:one",
        });

        return yield* Fiber.join(subscription);
      }),
    );

    expect(Option.isSome(event)).toBe(true);
  });
});
