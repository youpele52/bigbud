/**
 * Coordinator-side live progress of a delegated child (O-A): whether the worker child is running
 * or waiting (for example on an approval the worker's user must answer), as last reported by the
 * worker. It is live state, not part of the durable dispatch row: the follower records it from each
 * worker reply, and after a restart the next reply restores it.
 *
 * Workers before the `waiting` detail still report `state: "waiting"`; the reason is then read from
 * their workflow label. A detail this coordinator cannot decode (a newer worker) is dropped rather
 * than failing the whole reply, and any state other than `waiting` reads as running.
 *
 * @module peerDispatch.progress
 */
import type { PeerDispatch } from "@bigbud/contracts/server/remotePeer.ts";
import {
  PeerChildStatus,
  PeerChildWaiting,
  type PeerChildWaitReason,
} from "@bigbud/contracts/server/remotePeer.wire.ts";
import { Schema } from "effect";

import { isTerminalPeerDispatchState } from "../peer-orchestration/peerDispatch.transition.ts";

export interface PeerChildProgress {
  readonly state: "running" | "waiting";
  readonly workflowStatus: string;
  readonly waiting: PeerChildWaiting | null;
  /** When the worker last reported this; stale while the worker is unreachable. */
  readonly observedAt: string;
}

/** Live progress per dispatch id; entries exist only while the dispatch is unsettled. */
export type PeerChildProgressStore = Map<string, PeerChildProgress>;

const decodeStatus = Schema.decodeUnknownOption(PeerChildStatus);
const decodeWaiting = Schema.decodeUnknownOption(PeerChildWaiting);

/** Decodes a worker status reply; an undecodable `waiting` detail is dropped, not fatal. */
export function decodePeerChildStatus(body: unknown): PeerChildStatus | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const { waiting, ...rest } = body as Record<string, unknown>;
  const status = decodeStatus(rest);
  if (status._tag === "None") return undefined;
  const detail = waiting === undefined ? undefined : decodeWaiting(waiting);
  return detail?._tag === "Some" ? { ...status.value, waiting: detail.value } : status.value;
}

/** Workers before the `waiting` detail name the block only through their workflow label. */
const LEGACY_WAIT_REASONS: Readonly<Record<string, PeerChildWaitReason>> = {
  awaiting_approval: "approval-pending",
  awaiting_input: "user-input-pending",
};

export function peerChildProgress(status: PeerChildStatus, observedAt: string): PeerChildProgress {
  if (status.state !== "waiting")
    return { state: "running", workflowStatus: status.workflowStatus, waiting: null, observedAt };
  const legacy = LEGACY_WAIT_REASONS[status.workflowStatus];
  return {
    state: "waiting",
    workflowStatus: status.workflowStatus,
    waiting: status.waiting ?? (legacy ? { reason: legacy } : null),
    observedAt,
  };
}

const APPROVAL_KIND_LABEL = {
  command: "a command",
  "file-read": "a file read",
  "file-change": "a file change",
} as const;

function waitingGuidance(waiting: PeerChildWaiting | null): string {
  const what =
    waiting?.reason === "approval-pending"
      ? waiting.approvalKind
        ? `an approval of ${APPROVAL_KIND_LABEL[waiting.approvalKind]}`
        : "an approval"
      : waiting?.reason === "user-input-pending"
        ? "an answer to its question"
        : "the user";
  return `The worker child is waiting for ${what} on the worker host. Tell the user to answer it there; the result is delivered into this thread once the child finishes.`;
}

/** The tool-facing child progress of an unsettled dispatch, or undefined when none is known. */
export function peerChildProgressView(
  store: PeerChildProgressStore,
  dispatch: PeerDispatch,
):
  | {
      readonly state: PeerChildProgress["state"];
      readonly workflowStatus: string;
      readonly observedAt: string;
      readonly waiting?: PeerChildWaiting;
      readonly guidance?: string;
    }
  | undefined {
  if (isTerminalPeerDispatchState(dispatch.state)) return undefined;
  const progress = store.get(dispatch.dispatchId);
  if (!progress) return undefined;
  const base = {
    state: progress.state,
    workflowStatus: progress.workflowStatus,
    observedAt: progress.observedAt,
  };
  if (progress.state !== "waiting") return base;
  return {
    ...base,
    ...(progress.waiting ? { waiting: progress.waiting } : {}),
    guidance: waitingGuidance(progress.waiting),
  };
}
