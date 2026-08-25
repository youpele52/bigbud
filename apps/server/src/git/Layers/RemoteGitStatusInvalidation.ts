import { Effect, Layer, PubSub, Stream } from "effect";

import {
  RemoteGitStatusInvalidation,
  type RemoteGitStatusInvalidationKey,
} from "../Services/RemoteGitStatusInvalidation.ts";

export const makeRemoteGitStatusInvalidation = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<RemoteGitStatusInvalidationKey>();
  return {
    invalidate: (key: RemoteGitStatusInvalidationKey) =>
      PubSub.publish(changes, key).pipe(Effect.asVoid),
    changes: (key: RemoteGitStatusInvalidationKey) =>
      Stream.fromPubSub(changes).pipe(
        Stream.filter(
          (change) => change.cwd === key.cwd && change.executionTargetId === key.executionTargetId,
        ),
        Stream.map(() => undefined),
      ),
  };
});

export const RemoteGitStatusInvalidationLive = Layer.effect(
  RemoteGitStatusInvalidation,
  makeRemoteGitStatusInvalidation,
);
