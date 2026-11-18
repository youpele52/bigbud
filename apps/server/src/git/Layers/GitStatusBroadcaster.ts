/**
 * GitStatusBroadcaster - Per-cwd git status streaming via PubSub.
 *
 * Holds one PubSub<GitStatusStreamEvent> per active cwd.  Subscribers receive
 * an immediate snapshot on connect, then incremental `localUpdated` /
 * `remoteUpdated` events as changes are detected.
 *
 * @module GitStatusBroadcaster
 */
import { Effect, Layer, PubSub, Stream } from "effect";

import {
  type GitStatusLocalResult,
  type GitStatusRemoteResult,
  type GitStatusStreamEvent,
} from "@bigbud/contracts";
import { GitCore } from "../Services/GitCore.ts";
import {
  GitStatusBroadcaster,
  type GitStatusBroadcasterShape,
} from "../Services/GitStatusBroadcaster.ts";
import { type GitStatusDetails } from "../Services/GitCore.ts";

/**
 * Per-subscriber backlog for one cwd. Every event carries the full local or remote state, so
 * a slow subscriber (for example a remote client on a slow link) only needs the newest ones:
 * the PubSub slides, dropping that subscriber's oldest events instead of growing without limit.
 */
export const GIT_STATUS_SUBSCRIBER_BACKLOG_CAPACITY = 64;

// ── Helpers ────────────────────────────────────────────────────────────────────

function toLocalResult(details: GitStatusDetails): GitStatusLocalResult {
  return {
    isRepo: details.isRepo,
    hasOriginRemote: details.hasOriginRemote,
    isDefaultBranch: details.isDefaultBranch,
    branch: details.branch,
    hasWorkingTreeChanges: details.hasWorkingTreeChanges,
    workingTree: details.workingTree,
  };
}

/**
 * Entries live only while a cwd has subscribers (F-B9): the last subscriber leaving removes its
 * PubSub, so cwds a client looked at once do not stay in memory. The newest remote status of up
 * to this many cwds is kept (least recently refreshed evicted first) so a returning subscriber's
 * snapshot still carries ahead/behind counts until the next remote refresh.
 */
export const GIT_STATUS_RETAINED_REMOTE_CWD_CAPACITY = 256;

// ── Per-cwd broadcaster entry ──────────────────────────────────────────────────

interface BroadcasterEntry {
  readonly pubSub: PubSub.PubSub<GitStatusStreamEvent>;
  subscribers: number;
}

function emptyLocalResult(): GitStatusLocalResult {
  return {
    isRepo: false,
    hasOriginRemote: false,
    isDefaultBranch: false,
    branch: null,
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
  };
}

// ── Factory ───────────────────────────────────────────────────────────────────

export const makeGitStatusBroadcaster = Effect.fn("makeGitStatusBroadcaster")(function* () {
  const gitCore = yield* GitCore;

  // Canonicalized cwd → entry, present only while the cwd has at least one subscriber.
  const entries = new Map<string, BroadcasterEntry>();
  // Canonicalized cwd → newest remote status, bounded LRU (Map keeps insertion order).
  const remoteByCwd = new Map<string, GitStatusRemoteResult>();

  const rememberRemote = (cwd: string, remote: GitStatusRemoteResult) => {
    remoteByCwd.delete(cwd);
    remoteByCwd.set(cwd, remote);
    if (remoteByCwd.size > GIT_STATUS_RETAINED_REMOTE_CWD_CAPACITY) {
      const oldest = remoteByCwd.keys().next().value;
      if (oldest !== undefined) remoteByCwd.delete(oldest);
    }
  };

  const publish = (cwd: string, event: GitStatusStreamEvent) =>
    Effect.suspend(() => {
      const entry = entries.get(cwd);
      return entry ? PubSub.publish(entry.pubSub, event).pipe(Effect.asVoid) : Effect.void;
    });

  /** Registers one subscriber, creating the entry for its first. */
  const acquire = Effect.fn("GitStatusBroadcaster.acquire")(function* (cwd: string) {
    const existing = entries.get(cwd);
    if (existing) {
      existing.subscribers += 1;
      return existing;
    }
    const pubSub = yield* PubSub.sliding<GitStatusStreamEvent>(
      GIT_STATUS_SUBSCRIBER_BACKLOG_CAPACITY,
    );
    // Another subscriber may have created the entry while the PubSub was made.
    const raced = entries.get(cwd);
    if (raced) {
      raced.subscribers += 1;
      return raced;
    }
    const entry: BroadcasterEntry = { pubSub, subscribers: 1 };
    entries.set(cwd, entry);
    return entry;
  });

  /** Drops one subscriber; the last one removes the entry. */
  const release = (cwd: string, entry: BroadcasterEntry) =>
    Effect.suspend(() => {
      entry.subscribers -= 1;
      if (entry.subscribers > 0 || entries.get(cwd) !== entry) return Effect.void;
      entries.delete(cwd);
      return PubSub.shutdown(entry.pubSub);
    });

  const refreshLocal = Effect.fn("refreshLocal")(function* (cwd: string) {
    const details = yield* gitCore.statusDetailsLocal(cwd);
    const local = toLocalResult(details);
    yield* publish(cwd, { _tag: "localUpdated", local } as GitStatusStreamEvent);
    return local;
  });

  // ── Public API ────────────────────────────────────────────────────────────

  const subscribe: GitStatusBroadcasterShape["subscribe"] = Effect.fn("subscribe")(function* (cwd) {
    // Fetch the initial local snapshot; fall back to empty on error
    const local: GitStatusLocalResult = yield* gitCore.statusDetailsLocal(cwd).pipe(
      Effect.map(toLocalResult),
      Effect.catch(() => Effect.succeed(emptyLocalResult())),
    );
    const snapshot: GitStatusStreamEvent = {
      _tag: "snapshot",
      local,
      remote: remoteByCwd.get(cwd) ?? null,
    } as GitStatusStreamEvent;

    // Snapshot prefix + live events; the subscription holds the cwd's entry while it runs.
    const live = Stream.unwrap(
      Effect.acquireRelease(acquire(cwd), (entry) => release(cwd, entry)).pipe(
        Effect.map((entry) => Stream.fromPubSub(entry.pubSub)),
      ),
    );
    return Stream.concat(Stream.make(snapshot), live);
  });

  const invalidateLocal: GitStatusBroadcasterShape["invalidateLocal"] = (cwd) =>
    Effect.suspend(() =>
      // Nobody is listening: the next subscriber reads a fresh snapshot anyway.
      !entries.has(cwd)
        ? Effect.void
        : refreshLocal(cwd).pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              Effect.logWarning(
                "GitStatusBroadcaster.invalidateLocal: failed to refresh local status",
                {
                  cwd,
                  error: error instanceof Error ? error.message : String(error),
                },
              ),
            ),
          ),
    );

  const refreshLocalStatus: GitStatusBroadcasterShape["refreshLocalStatus"] = Effect.fn(
    "refreshLocalStatus",
  )(function* (cwd) {
    return yield* refreshLocal(cwd);
  });

  const invalidateRemote: GitStatusBroadcasterShape["invalidateRemote"] = (cwd) =>
    Effect.gen(function* () {
      // Remote status is read via the full statusDetails (which includes upstream)
      // but we only publish the remote part to avoid triggering another local write.
      const details = yield* gitCore.statusDetails(cwd);
      const remote: GitStatusRemoteResult = {
        hasUpstream: details.hasUpstream,
        aheadCount: details.aheadCount,
        behindCount: details.behindCount,
        pr: null,
      };
      rememberRemote(cwd, remote);
      yield* publish(cwd, { _tag: "remoteUpdated", remote } as GitStatusStreamEvent);
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          "GitStatusBroadcaster.invalidateRemote: failed to refresh remote status",
          {
            cwd,
            error: error instanceof Error ? error.message : String(error),
          },
        ),
      ),
    );

  return {
    subscribe,
    refreshLocalStatus,
    invalidateLocal,
    invalidateRemote,
    /** Live per-cwd entries (for tests and diagnostics). */
    activeCwdCount: () => entries.size,
  } satisfies GitStatusBroadcasterShape & { readonly activeCwdCount: () => number };
});

export const GitStatusBroadcasterLive = Layer.effect(
  GitStatusBroadcaster,
  makeGitStatusBroadcaster(),
);
