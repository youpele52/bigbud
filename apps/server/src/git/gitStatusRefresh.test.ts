import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { makeGitStatusRefresh } from "./gitStatusRefresh.ts";

describe("makeGitStatusRefresh", () => {
  it("uses local caches and broadcasters for the explicit local target", async () => {
    const calls: string[] = [];
    const refresh = makeGitStatusRefresh({
      gitManager: {
        invalidateStatus: (cwd) =>
          Effect.sync(() => calls.push(`manager:${cwd}`)).pipe(Effect.asVoid),
      },
      gitStatusBroadcaster: {
        invalidateLocal: (cwd) => Effect.sync(() => calls.push(`local:${cwd}`)).pipe(Effect.asVoid),
        invalidateRemote: (cwd) =>
          Effect.sync(() => calls.push(`remote:${cwd}`)).pipe(Effect.asVoid),
      },
      remoteGitStatusInvalidation: {
        invalidate: ({ cwd, executionTargetId }) =>
          Effect.sync(() => calls.push(`target:${executionTargetId}:${cwd}`)).pipe(Effect.asVoid),
        changes: () => Stream.never,
      },
    });

    await Effect.runPromise(refresh("/local/project", "local"));

    expect(calls).toEqual([
      "manager:/local/project",
      "local:/local/project",
      "remote:/local/project",
    ]);
  });

  it("invalidates only the target-keyed remote stream for remote workspaces", async () => {
    const calls: string[] = [];
    const refresh = makeGitStatusRefresh({
      gitManager: {
        invalidateStatus: (cwd) =>
          Effect.sync(() => calls.push(`manager:${cwd}`)).pipe(Effect.asVoid),
      },
      gitStatusBroadcaster: {
        invalidateLocal: (cwd) => Effect.sync(() => calls.push(`local:${cwd}`)).pipe(Effect.asVoid),
        invalidateRemote: (cwd) =>
          Effect.sync(() => calls.push(`remote:${cwd}`)).pipe(Effect.asVoid),
      },
      remoteGitStatusInvalidation: {
        invalidate: ({ cwd, executionTargetId }) =>
          Effect.sync(() => calls.push(`target:${executionTargetId}:${cwd}`)).pipe(Effect.asVoid),
        changes: () => Stream.never,
      },
    });

    await Effect.runPromise(refresh("/srv/project", "ssh:example"));

    expect(calls).toEqual(["target:ssh:example:/srv/project"]);
  });
});
