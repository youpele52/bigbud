import { CheckpointRef, GitCommandError } from "@bigbud/contracts";
import { Effect, Encoding } from "effect";

import type { GitCoreShape } from "../../git/Services/GitCore.ts";
import { CheckpointInvariantError } from "../Errors.ts";
import type { CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import type { makeCheckpointIdentityOps } from "./CheckpointStore.identity.ts";
import {
  CHECKPOINT_REFS_PREFIX,
  LEGACY_CHECKPOINT_REFS_PREFIX,
  PATH_CHECKPOINT_REFS_PREFIX,
} from "../Utils.ts";

export function makeCheckpointRefOps(
  git: GitCoreShape,
  identityOps: ReturnType<typeof makeCheckpointIdentityOps>,
) {
  const listThreadCheckpointRefs: CheckpointStoreShape["listThreadCheckpointRefs"] = Effect.fn(
    "listThreadCheckpointRefs",
  )(function* (input) {
    const identity = input.identity ?? (yield* identityOps.captureRepositoryIdentity(input.cwd));
    const encodedThreadId = Encoding.encodeBase64Url(input.threadId);
    const prefixes = [
      `${CHECKPOINT_REFS_PREFIX}/${encodedThreadId}/`,
      `${LEGACY_CHECKPOINT_REFS_PREFIX}/${encodedThreadId}/`,
      `${PATH_CHECKPOINT_REFS_PREFIX}/${encodedThreadId}/`,
    ];
    const refs = new Set<CheckpointRef>();
    for (const prefix of prefixes) {
      const cwd = yield* identityOps.assertRepositoryIdentity(input.cwd, identity);
      const result = yield* git.execute({
        operation: "CheckpointStore.listThreadCheckpointRefs",
        cwd,
        args: ["for-each-ref", "--format=%(refname)", prefix],
      });
      yield* identityOps.assertRepositoryIdentity(input.cwd, identity);
      for (const ref of result.stdout
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean)) {
        if (!ref.startsWith(prefix)) {
          return yield* new CheckpointInvariantError({
            operation: "CheckpointStore.listThreadCheckpointRefs",
            detail: "Git returned a checkpoint ref outside the requested thread prefix.",
          });
        }
        refs.add(CheckpointRef.makeUnsafe(ref));
      }
    }
    return [...refs].toSorted();
  });

  const deleteCheckpointRefs: CheckpointStoreShape["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    const operation = "CheckpointStore.deleteCheckpointRefs";
    const identity = input.identity ?? (yield* identityOps.captureRepositoryIdentity(input.cwd));
    yield* identityOps.assertRepositoryIdentity(input.cwd, identity);

    yield* Effect.forEach(
      input.checkpointRefs,
      (checkpointRef) =>
        identityOps.assertRepositoryIdentity(input.cwd, identity).pipe(
          Effect.flatMap((cwd) =>
            git
              .execute({
                operation,
                cwd,
                args: ["update-ref", "-d", checkpointRef],
              })
              .pipe(Effect.tap(() => identityOps.assertRepositoryIdentity(input.cwd, identity))),
          ),
        ),
      { discard: true },
    );
  });

  const verifyCheckpointRefsAbsent: CheckpointStoreShape["verifyCheckpointRefsAbsent"] = Effect.fn(
    "verifyCheckpointRefsAbsent",
  )(function* (input) {
    const identity = input.identity ?? (yield* identityOps.captureRepositoryIdentity(input.cwd));
    yield* identityOps.assertRepositoryIdentity(input.cwd, identity);
    for (const checkpointRef of input.checkpointRefs) {
      const cwd = yield* identityOps.assertRepositoryIdentity(input.cwd, identity);
      const result = yield* git.execute({
        operation: "CheckpointStore.verifyCheckpointRefsAbsent",
        cwd,
        args: ["show-ref", "--verify", "--quiet", checkpointRef],
        allowNonZeroExit: true,
      });
      yield* identityOps.assertRepositoryIdentity(input.cwd, identity);
      if (result.code === 0) {
        return yield* new CheckpointInvariantError({
          operation: "CheckpointStore.verifyCheckpointRefsAbsent",
          detail: `Checkpoint ref remains after deletion: ${checkpointRef}`,
        });
      }
      if (result.code !== 1) {
        return yield* new GitCommandError({
          operation: "CheckpointStore.verifyCheckpointRefsAbsent",
          command: "git show-ref --verify --quiet",
          cwd,
          detail: result.stderr.trim() || `git show-ref exited with code ${result.code}`,
        });
      }
    }
  });

  return { listThreadCheckpointRefs, deleteCheckpointRefs, verifyCheckpointRefsAbsent };
}
