/**
 * Worker-side reads shared by delegate, status, follow and cancel (WP-8B, F-P8-3): the child's
 * thread and its bounded peer status, including a start intent the worker is still completing.
 *
 * @module peerWorker.read
 */
import { ThreadId, type OrchestrationThread } from "@bigbud/contracts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { PeerChild, PeerChildRepositoryShape } from "../persistence/Services/PeerChildren.ts";
import { PEER_START_CANCELLED, type PeerChildStarter } from "./peerWorker.start.ts";
import { peerChildPendingStartStatus, peerChildStatus } from "./peerWorker.status.ts";

export interface PeerWorkerDeps {
  readonly engine: OrchestrationEngineShape;
  readonly children: PeerChildRepositoryShape;
  readonly starter: PeerChildStarter;
}

/** History-level thread state, falling back to the operational read model. */
export const loadPeerChildThread = Effect.fn("loadPeerChildThread")(function* (
  engine: OrchestrationEngineShape,
  childThreadId: string,
) {
  const id = ThreadId.makeUnsafe(childThreadId);
  if (engine.ensureThreadState) {
    const thread = yield* engine.ensureThreadState(id, "history");
    if (thread) return thread;
  }
  const readModel = yield* engine.getReadModel();
  return readModel.threads.find((thread) => thread.id === id) as OrchestrationThread | undefined;
});

/**
 * The child's status, or undefined when neither a start intent nor its thread exists (a record
 * from before migration 179 whose delegate never finished: the coordinator re-sends it).
 */
export const readPeerChildStatus = Effect.fn("readPeerChildStatus")(function* (
  deps: PeerWorkerDeps,
  child: PeerChild,
) {
  if (child.startFailure !== null) return peerChildPendingStartStatus(child, PEER_START_CANCELLED);
  if (child.start !== null && child.startCompletedAt === null) {
    // Probes drive an interrupted or crashed start to completion.
    yield* deps.starter.kick(child);
    return peerChildPendingStartStatus(child, PEER_START_CANCELLED);
  }
  const thread = yield* loadPeerChildThread(deps.engine, child.childThreadId);
  return thread ? peerChildStatus(child, thread) : undefined;
});

/** Re-reads the record by command id, then its status. */
export const peerWorkerChildStatus = Effect.fn("peerWorkerChildStatus")(function* (
  deps: PeerWorkerDeps,
  commandId: string,
) {
  const child = yield* deps.children.findByCommand(commandId);
  return child ? yield* readPeerChildStatus(deps, child) : undefined;
});
