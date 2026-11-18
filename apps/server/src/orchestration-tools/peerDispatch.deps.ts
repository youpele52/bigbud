/**
 * Dependencies of the coordinator dispatcher (WP-8D), injected so tests drive the real state
 * machine and repositories against a fake transport.
 *
 * @module peerDispatch.deps
 */
import type { RuntimeMode } from "@bigbud/contracts";
import type { PeerSetupError } from "@bigbud/contracts/server/remotePeer.pairing.ts";
import type { Effect } from "effect";

import type { PeerDispatchRepositoryShape } from "../persistence/Services/PeerDispatches.ts";
import type { PeerDispatchRequestRepositoryShape } from "../persistence/Services/PeerDispatchRequests.ts";
import type { PeerPairingRepositoryShape } from "../persistence/Services/PeerPairings.ts";
import type { PeerDeliver } from "./peerDispatch.delivery.ts";
import type { PeerToolWaits } from "./peerDispatch.toolWait.ts";
import type { PeerTransport } from "./peerDispatch.transport.ts";

export interface PeerCoordinatorDeps {
  /** This backend's authority id; null outside remote mode, where peer dispatch is unavailable. */
  readonly coordinatorAuthorityId: string | null;
  readonly dispatches: PeerDispatchRepositoryShape;
  readonly requests: PeerDispatchRequestRepositoryShape;
  readonly pairings: PeerPairingRepositoryShape;
  readonly transport: PeerTransport;
  readonly deliver: PeerDeliver;
  /** The calling thread's runtime mode, so its narrower permissions propagate. */
  readonly callerRuntimeMode: (threadId: string) => Effect.Effect<RuntimeMode | null>;
  /** Per-worker setup errors (host key, key authentication); cleared by a definite reply. */
  readonly setupErrors: Map<string, PeerSetupError>;
  /** Delegate tool calls waiting in-call; decides who reports a refusal before acceptance. */
  readonly toolWaits: PeerToolWaits;
  readonly now: () => string;
  readonly newDispatchId: () => string;
  /** Backoff before the next attempt after an unreachable worker. */
  readonly retryDelayMs: (attempt: number) => number;
  /** Long-poll length of one `follow` request. */
  readonly followWaitMs: number;
}

export const defaultPeerRetryDelayMs = (attempt: number) =>
  Math.min(30_000, 1_000 * 2 ** Math.min(5, Math.max(0, attempt - 1)));
