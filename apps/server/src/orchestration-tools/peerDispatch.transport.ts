/**
 * Coordinator peer transport boundary (WP-8D). The dispatcher talks to workers only through this
 * interface; the live implementation is the dedicated-key SSH channel
 * (`peer-orchestration/peerCoordinator.transport.ts`). Outcomes are classified once here so the
 * dispatcher never guesses from raw status codes.
 *
 * @module peerDispatch.transport
 */
import {
  PeerError,
  type PeerAction,
  type PeerErrorCode,
} from "@bigbud/contracts/server/remotePeer.ts";
import type {
  PeerPairing,
  PeerSetupErrorCode,
} from "@bigbud/contracts/server/remotePeer.pairing.ts";
import { Schema } from "effect";

export type PeerTransportOutcome =
  /** A 2xx JSON reply; the caller decodes it for the action. */
  | { readonly _tag: "ok"; readonly body: unknown }
  /** The worker answered with a typed `PeerError`. */
  | { readonly _tag: "refused"; readonly error: PeerError }
  /** Host key pin or key authentication failed: needs the user, never retried. */
  | { readonly _tag: "setup"; readonly code: PeerSetupErrorCode; readonly message: string }
  /** Nothing definite is known (partition, timeout, closed channel, malformed reply). */
  | { readonly _tag: "unreachable"; readonly message: string };

export interface PeerTransport {
  readonly request: (input: {
    readonly pairing: PeerPairing;
    readonly action: PeerAction;
    readonly body: unknown;
    readonly deadlineMs: number;
    readonly signal: AbortSignal;
  }) => Promise<PeerTransportOutcome>;
}

const decodeErrorBody = Schema.decodeUnknownOption(Schema.Struct({ error: PeerError }));

/** Classifies one HTTP reply from the worker peer socket. */
export function classifyPeerReply(status: number, body: unknown): PeerTransportOutcome {
  if (status >= 200 && status < 300) return { _tag: "ok", body };
  const refusal = decodeErrorBody(body);
  if (refusal._tag === "Some") return { _tag: "refused", error: refusal.value.error };
  return { _tag: "unreachable", message: `The worker replied with HTTP ${status}.` };
}

/** Refusals that settle an uncertain delegate: the worker definitively did not accept it. */
const DELEGATE_FINAL: ReadonlySet<PeerErrorCode> = new Set([
  "grant-missing",
  "grant-expired",
  "grant-revoked",
  "authority-mismatch",
  "action-not-allowed",
  "permission-exceeds-ceiling",
  "workspace-unavailable",
  "dispatch-conflict",
]);

/** Refusals that end following an accepted child: the coordinator can no longer observe it. */
const FOLLOW_FINAL: ReadonlySet<PeerErrorCode> = new Set([
  "grant-missing",
  "grant-expired",
  "grant-revoked",
  "authority-mismatch",
  "action-not-allowed",
  "dispatch-unknown",
]);

export const isFinalDelegateRefusal = (code: PeerErrorCode) => DELEGATE_FINAL.has(code);
export const isFinalFollowRefusal = (code: PeerErrorCode) => FOLLOW_FINAL.has(code);
