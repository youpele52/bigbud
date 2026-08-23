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
});
