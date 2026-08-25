import { ServiceMap, type Effect, type Stream } from "effect";

export interface RemoteGitStatusInvalidationKey {
  readonly cwd: string;
  readonly executionTargetId: string;
}

export interface RemoteGitStatusInvalidationShape {
  readonly invalidate: (key: RemoteGitStatusInvalidationKey) => Effect.Effect<void>;
  readonly changes: (key: RemoteGitStatusInvalidationKey) => Stream.Stream<void>;
}

export class RemoteGitStatusInvalidation extends ServiceMap.Service<
  RemoteGitStatusInvalidation,
  RemoteGitStatusInvalidationShape
>()("t3/git/Services/RemoteGitStatusInvalidation") {}
