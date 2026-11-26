/**
 * Coordinator-side peer channel types (D10, WP-8C). Every peer channel is a Rust owner relay
 * lease with a pinned worker host key (`peerRelay.ssh.owner.ts`, U24); there is no TypeScript
 * `ssh` child.
 *
 * @module peerRelay.ssh
 */
import type { Duplex } from "node:stream";

export type PeerRelayChannelOutcome =
  | "closed"
  | "host-identity-mismatch"
  | "authentication-refused"
  | "unreachable";

export interface PeerRelayChannel {
  readonly stream: Duplex;
  /** Settles when the channel ends, classifying why. */
  readonly outcome: Promise<PeerRelayChannelOutcome>;
}
