/**
 * Delivers one delegated child's bounded result into the coordinator thread (WP-8D).
 *
 * Exactly once per dispatch identity: the follower delivers before it settles the row, and the
 * delivery is a `thread.turn.start` whose command id and message id are pure functions of the
 * dispatch id. A crash between delivery and settlement re-delivers on resume, and the
 * orchestration command receipt answers with the first outcome (or a digest conflict, which also
 * means it was delivered) instead of starting a second turn.
 *
 * @module peerDispatch.delivery
 */
import { requireActiveModelSelection } from "@bigbud/shared/providerLifecycle";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ThreadId,
} from "@bigbud/contracts";
import type { PeerDispatch, PeerResultSummary } from "@bigbud/contracts/server/remotePeer.ts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { loadPeerChildThread } from "../peer-orchestration/peerWorker.read.ts";
import { stableThreadToolId } from "./ThreadOrchestrationTools.origins.ts";

export interface PeerResultDelivery {
  readonly commandId: string;
  readonly threadId: string;
  readonly text: string;
}

export type PeerDeliver = (delivery: PeerResultDelivery) => Effect.Effect<void, Error>;

export const peerResultCommandId = (dispatchId: string) => `peer-result:${dispatchId}`;

/** The delivered message; deterministic for one dispatch and one worker result. */
export function buildPeerResultDelivery(
  dispatch: PeerDispatch,
  workerLabel: string,
  result: PeerResultSummary,
): PeerResultDelivery {
  const header =
    `Delegated task ${dispatch.dispatchId} on ${workerLabel} ${result.outcome}` +
    ` (worker thread ${dispatch.childThreadId ?? "unknown"}).`;
  const note = result.truncated ? "\n\n[The worker truncated this summary to its bound.]" : "";
  const attachments =
    result.attachments.length === 0
      ? ""
      : `\n\nAttachments offered by the worker: ${result.attachments
          .map((entry) => `${entry.name} (${entry.sizeBytes} bytes)`)
          .join(", ")}`;
  return {
    commandId: peerResultCommandId(dispatch.dispatchId),
    threadId: dispatch.coordinatorThreadId,
    text: `${header}\n\n${result.summary || "(no summary)"}${note}${attachments}`,
  };
}

/** Live delivery through the orchestration engine, mirroring completion-watch triggers. */
export function makeEnginePeerDeliver(engine: OrchestrationEngineShape): PeerDeliver {
  return Effect.fn("peerDispatch.deliver")(function* (delivery: PeerResultDelivery) {
    const thread = yield* loadPeerChildThread(engine, delivery.threadId);
    if (!thread || thread.deletedAt !== null) return;
    yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(delivery.commandId),
        threadId: ThreadId.makeUnsafe(delivery.threadId),
        message: {
          messageId: MessageId.makeUnsafe(stableThreadToolId("peer-result", delivery.commandId)),
          role: "user",
          text: delivery.text,
          attachments: [],
        },
        ...(thread.modelSelection !== undefined
          ? { modelSelection: requireActiveModelSelection(thread.modelSelection) }
          : {}),
        runtimeMode: thread.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        interactionMode: thread.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: new Date().toISOString(),
      })
      .pipe(
        // A receipt already holds this command id with another digest: it was delivered once.
        Effect.catchTag("OrchestrationCommandIdConflictError", () => Effect.void),
        Effect.mapError((error) => new Error(String((error as Error).message ?? error))),
      );
  });
}
