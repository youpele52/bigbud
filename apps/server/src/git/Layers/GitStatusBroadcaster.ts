/**
 * GitStatusBroadcaster - Per-cwd git status streaming via PubSub.
 *
 * Holds one PubSub<GitStatusStreamEvent> per active cwd.  Subscribers receive
 * an immediate snapshot on connect, then incremental `localUpdated` /
 * `remoteUpdated` events as changes are detected.
 *
 * @module GitStatusBroadcaster
 */
import { Effect, Layer, PubSub, Ref, Stream } from "effect";

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

// ── Per-cwd broadcaster entry ──────────────────────────────────────────────────

interface BroadcasterEntry {
  pubSub: PubSub.PubSub<GitStatusStreamEvent>;
  localRef: Ref.Ref<GitStatusLocalResult | null>;
  remoteRef: Ref.Ref<GitStatusRemoteResult | null>;
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

  // Map from canonicalized cwd → BroadcasterEntry
  const entriesRef = yield* Ref.make(new Map<string, BroadcasterEntry>());

  const getOrCreateEntry = Effect.fn("getOrCreateEntry")(function* (
    cwd: string,
  ): Effect.fn.Return<BroadcasterEntry> {
    const map = yield* Ref.get(entriesRef);
    const existing = map.get(cwd);
    if (existing) return existing;

    const pubSub = yield* PubSub.unbounded<GitStatusStreamEvent>();
    const localRef = yield* Ref.make<GitStatusLocalResult | null>(null);
    const remoteRef = yield* Ref.make<GitStatusRemoteResult | null>(null);
    const entry: BroadcasterEntry = { pubSub, localRef, remoteRef };

    yield* Ref.update(entriesRef, (m) => new Map([...m, [cwd, entry]]));
    return entry;
  });

  const refreshLocal = Effect.fn("refreshLocal")(function* (cwd: string, entry: BroadcasterEntry) {
    const details = yield* gitCore.statusDetailsLocal(cwd);
    const local = toLocalResult(details);
    yield* Ref.set(entry.localRef, local);
    yield* PubSub.publish(entry.pubSub, { _tag: "localUpdated", local } as GitStatusStreamEvent);
    return local;
  });

  // ── Public API ────────────────────────────────────────────────────────────

  const subscribe: GitStatusBroadcasterShape["subscribe"] = Effect.fn("subscribe")(function* (cwd) {
    const entry = yield* getOrCreateEntry(cwd);

    // Fetch the initial local snapshot; fall back to empty on error
    const local: GitStatusLocalResult = yield* gitCore.statusDetailsLocal(cwd).pipe(
      Effect.map(toLocalResult),
      Effect.catch(() => Effect.succeed(emptyLocalResult())),
    );

    // Store in cache
    yield* Ref.set(entry.localRef, local);

    const remote = yield* Ref.get(entry.remoteRef);

    const snapshot: GitStatusStreamEvent = {
      _tag: "snapshot",
      local,
      remote,
    } as GitStatusStreamEvent;

    // Build stream: snapshot prefix + live events from pubSub
    const liveStream = Stream.fromPubSub(entry.pubSub);
    const snapshotStream = Stream.make(snapshot);
    return Stream.concat(snapshotStream, liveStream);
  });

  const invalidateLocal: GitStatusBroadcasterShape["invalidateLocal"] = (cwd) =>
    Effect.gen(function* () {
      const entry = yield* getOrCreateEntry(cwd);
      yield* refreshLocal(cwd, entry).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            "GitStatusBroadcaster.invalidateLocal: failed to refresh local status",
            {
              cwd,
              error: error instanceof Error ? error.message : String(error),
            },
          ),
        ),
      );
    });

  const refreshLocalStatus: GitStatusBroadcasterShape["refreshLocalStatus"] = Effect.fn(
    "refreshLocalStatus",
  )(function* (cwd) {
    const entry = yield* getOrCreateEntry(cwd);
    return yield* refreshLocal(cwd, entry);
  });

  const invalidateRemote: GitStatusBroadcasterShape["invalidateRemote"] = (cwd) =>
    Effect.gen(function* () {
      const entry = yield* getOrCreateEntry(cwd);
      // Remote status is read via the full statusDetails (which includes upstream)
      // but we only publish the remote part to avoid triggering another local write.
      yield* Effect.gen(function* () {
        const details = yield* gitCore.statusDetails(cwd);
        const remote: GitStatusRemoteResult = {
          hasUpstream: details.hasUpstream,
          aheadCount: details.aheadCount,
          behindCount: details.behindCount,
          pr: null,
        };
        yield* Ref.set(entry.remoteRef, remote);
        yield* PubSub.publish(entry.pubSub, {
          _tag: "remoteUpdated",
          remote,
        } as GitStatusStreamEvent);
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
    });

  return {
    subscribe,
    refreshLocalStatus,
    invalidateLocal,
    invalidateRemote,
  } satisfies GitStatusBroadcasterShape;
});

export const GitStatusBroadcasterLive = Layer.effect(
  GitStatusBroadcaster,
  makeGitStatusBroadcaster(),
);
