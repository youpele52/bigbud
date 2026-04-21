/**
 * GitStatusBroadcaster - Effect service contract for streaming git status events per-cwd.
 *
 * Subscribers receive an initial snapshot followed by `localUpdated` / `remoteUpdated`
 * stream events as the working tree or upstream changes.
 *
 * @module GitStatusBroadcaster
 */
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";
import type {
  GitManagerServiceError,
  GitStatusLocalResult,
  GitStatusStreamEvent,
} from "@bigbud/contracts";

export interface GitStatusBroadcasterShape {
  /**
   * Subscribe to git status stream events for the given cwd.
   * Emits a `snapshot` event immediately, then `localUpdated` / `remoteUpdated`
   * as changes are detected.
   */
  readonly subscribe: (
    cwd: string,
  ) => Effect.Effect<Stream.Stream<GitStatusStreamEvent, GitManagerServiceError>>;

  /**
   * Refresh and return the current local snapshot for the given cwd.
   */
  readonly refreshLocalStatus: (
    cwd: string,
  ) => Effect.Effect<GitStatusLocalResult, GitManagerServiceError>;

  /**
   * Trigger an immediate local status refresh for the given cwd (e.g. after a branch op).
   * Fire-and-forget; errors are logged and swallowed.
   */
  readonly invalidateLocal: (cwd: string) => Effect.Effect<void>;

  /**
   * Trigger an immediate remote status refresh for the given cwd (e.g. after a push/pull).
   * Fire-and-forget; errors are logged and swallowed.
   */
  readonly invalidateRemote: (cwd: string) => Effect.Effect<void>;
}

/**
 * GitStatusBroadcaster - Service tag for per-cwd git status streaming.
 */
export class GitStatusBroadcaster extends ServiceMap.Service<
  GitStatusBroadcaster,
  GitStatusBroadcasterShape
>()("t3/git/Services/GitStatusBroadcaster") {}
