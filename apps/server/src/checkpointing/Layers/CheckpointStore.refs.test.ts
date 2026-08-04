import { CheckpointRef } from "@bigbud/contracts";
import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { expect } from "vitest";

import type { GitCoreShape } from "../../git/Services/GitCore.ts";
import type { CheckpointRepositoryIdentity } from "../Services/CheckpointStore.ts";
import { makeCheckpointRefOps } from "./CheckpointStore.refs.ts";

const identity: CheckpointRepositoryIdentity = {
  workspace: { canonicalPath: "/repo", device: 1, inode: 2 },
  gitCommonDir: { canonicalPath: "/repo/.git", device: 1, inode: 3 },
};

it.effect("fails verification when git cannot prove ref absence", () =>
  Effect.gen(function* () {
    const git = {
      execute: () =>
        Effect.succeed({
          code: 128,
          stdout: "",
          stderr: "fatal: repository unavailable",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
    } as unknown as GitCoreShape;
    const identityOps = {
      captureRepositoryIdentity: () => Effect.succeed(identity),
      assertRepositoryIdentity: () => Effect.succeed(identity.workspace.canonicalPath),
    } as never;
    const refs = makeCheckpointRefOps(git, identityOps);

    const exit = yield* Effect.exit(
      refs.verifyCheckpointRefsAbsent({
        cwd: "/repo",
        checkpointRefs: [CheckpointRef.makeUnsafe("refs/bigbud/checkpoints/dGhyZWFk/1")],
        identity,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  }),
);
