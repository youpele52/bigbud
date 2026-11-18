/**
 * Who reports a refusal that arrives before the worker accepted a dispatch.
 *
 * `delegate_to_host` waits briefly in-call for the follower to leave the uncertain states. A
 * definite refusal inside that wait is the tool's own answer; one that arrives after the tool
 * returned (`pending`/`sent-uncertain`) must be delivered into the coordinator thread instead,
 * exactly once. The follower hands a refusal off here before it settles the row: while a tool call
 * is waiting the refusal is recorded for that call and nothing is delivered; otherwise (the tool
 * returned, or the backend restarted since) the follower delivers it.
 *
 * Both sides decide synchronously, so they are linearized: either the follower records the
 * refusal before the tool stops waiting (the tool reports it), or the tool stopped waiting first
 * (the follower delivers it). Entries exist only while a tool call is waiting.
 *
 * @module peerDispatch.toolWait
 */
import type { PeerError } from "@bigbud/contracts/server/remotePeer.ts";

export interface PeerToolWaits {
  /** A delegate tool call starts waiting in-call for this dispatch. */
  readonly enter: (dispatchId: string) => void;
  /** That tool call stops waiting; returns a refusal handed to it while it waited. */
  readonly leave: (dispatchId: string) => PeerError | undefined;
  /**
   * The follower is about to settle a refusal before acceptance. `true`: a waiting tool call
   * reports it (recorded here, do not deliver). `false`: no tool call waits, deliver it.
   */
  readonly handOff: (dispatchId: string, error: PeerError) => boolean;
}

interface Waiting {
  waiters: number;
  refusal: PeerError | undefined;
}

export function makePeerToolWaits(): PeerToolWaits {
  const waiting = new Map<string, Waiting>();
  return {
    enter: (dispatchId) => {
      const entry = waiting.get(dispatchId);
      if (entry) entry.waiters++;
      else waiting.set(dispatchId, { waiters: 1, refusal: undefined });
    },
    leave: (dispatchId) => {
      const entry = waiting.get(dispatchId);
      if (!entry) return undefined;
      entry.waiters--;
      if (entry.waiters <= 0) waiting.delete(dispatchId);
      return entry.refusal;
    },
    handOff: (dispatchId, error) => {
      const entry = waiting.get(dispatchId);
      if (!entry) return false;
      entry.refusal = error;
      return true;
    },
  };
}
