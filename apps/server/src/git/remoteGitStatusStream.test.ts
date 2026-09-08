import { Effect, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { GitCoreShape } from "./Services/GitCore.ts";
import { makeRemoteGitStatusStream } from "./remoteGitStatusStream.ts";

describe("remote Git status stream", () => {
  it("emits a target-aware initial snapshot", async () => {
    const git = {
      status: (input: { readonly cwd: string; readonly executionTargetId?: string }) => {
        expect(input).toEqual({ cwd: "/remote/project", executionTargetId: "ssh:example" });
        return Effect.succeed({
          isRepo: true,
          hasOriginRemote: true,
          isDefaultBranch: true,
          branch: "main",
          hasWorkingTreeChanges: true,
          workingTree: {
            files: [{ path: "README.md", insertions: 1, deletions: 0 }],
            insertions: 1,
            deletions: 0,
          },
          hasUpstream: true,
          aheadCount: 2,
          behindCount: 1,
          pr: null,
        });
      },
    } as unknown as GitCoreShape;

    const stream = await Effect.runPromise(
      makeRemoteGitStatusStream({
        git,
        cwd: "/remote/project",
        executionTargetId: "ssh:example",
        invalidation: {
          invalidate: () => Effect.void,
          changes: () => Stream.never,
        },
      }),
    );
    const event = await Effect.runPromise(Stream.runHead(stream));

    expect(Option.isSome(event) && event.value).toEqual({
      _tag: "snapshot",
      local: {
        isRepo: true,
        hasOriginRemote: true,
        isDefaultBranch: true,
        branch: "main",
        hasWorkingTreeChanges: true,
        workingTree: {
          files: [{ path: "README.md", insertions: 1, deletions: 0 }],
          insertions: 1,
          deletions: 0,
        },
      },
      remote: { hasUpstream: true, aheadCount: 2, behindCount: 1, pr: null },
    });
  });

  it("refreshes immediately when the target is invalidated", async () => {
    let calls = 0;
    const git = {
      status: () => {
        calls += 1;
        return Effect.succeed({
          isRepo: true,
          hasOriginRemote: true,
          isDefaultBranch: true,
          branch: "main",
          hasWorkingTreeChanges: calls > 1,
          workingTree: {
            files: calls > 1 ? [{ path: "changed.ts", insertions: 1, deletions: 0 }] : [],
            insertions: calls > 1 ? 1 : 0,
            deletions: 0,
          },
          hasUpstream: true,
          aheadCount: 0,
          behindCount: 0,
          pr: null,
        });
      },
    } as unknown as GitCoreShape;

    const stream = await Effect.runPromise(
      makeRemoteGitStatusStream({
        git,
        cwd: "/remote/project",
        executionTargetId: "ssh:example",
        invalidation: {
          invalidate: () => Effect.void,
          changes: () => Stream.make(undefined),
        },
      }),
    );
    const events = await Effect.runPromise(stream.pipe(Stream.take(2), Stream.runCollect));

    expect(calls).toBe(2);
    expect(Array.from(events)[1]).toMatchObject({
      _tag: "localUpdated",
      local: { hasWorkingTreeChanges: true },
    });
  });
});
