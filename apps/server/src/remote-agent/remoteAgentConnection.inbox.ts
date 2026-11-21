/**
 * Frame routing for one remote-agent connection: frame listeners, request waiters, and the
 * bounded set of frames nobody has claimed yet (F-B6).
 *
 * A frame no listener consumed and no waiter matched is kept for a later `request` or
 * `nextFrame`. That set is capped at {@link REMOTE_AGENT_UNCLAIMED_FRAME_CAPACITY}: an agent that
 * keeps sending frames nobody asked for would otherwise grow it without limit. Unclaimed frames
 * can be replies a caller will still collect, so dropping one could leave a request waiting
 * forever. Overflow therefore fails the connection with a protocol error instead: every waiter
 * and failure listener sees it, and the pool reconnects.
 *
 * @module remoteAgentConnection.inbox
 */
import type { FrameWaiter } from "./remoteAgentConnection.request.ts";
import { RemoteAgentProtocolDecodeError, type RemoteAgentFrame } from "./remoteAgentProtocol.ts";

/** Frames kept for a later request before the connection fails as a protocol error. */
export const REMOTE_AGENT_UNCLAIMED_FRAME_CAPACITY = 1_024;

/** Frame types that are discarded, never kept, when no listener or waiter claims them. */
const DROPPED_WHEN_UNCLAIMED: ReadonlySet<RemoteAgentFrame["type"]> = new Set([
  "ptyOutput",
  "ptyExited",
  "ptyAttachResponse",
  "hostResourceReport",
  "ptyActivity",
  "ptyLifecycleNotice",
]);

export type FrameListener = (frame: RemoteAgentFrame) => boolean | void;

export class RemoteAgentFrameInbox {
  readonly waiters: FrameWaiter[] = [];
  readonly listeners = new Set<FrameListener>();
  private readonly unclaimed: RemoteAgentFrame[] = [];

  constructor(private readonly capacity: number = REMOTE_AGENT_UNCLAIMED_FRAME_CAPACITY) {}

  get unclaimedCount(): number {
    return this.unclaimed.length;
  }

  /** Routes one frame. Returns a protocol error when the unclaimed set would exceed its cap. */
  deliver(frame: RemoteAgentFrame): RemoteAgentProtocolDecodeError | undefined {
    let consumed = false;
    for (const listener of this.listeners) {
      if (listener(frame) === true) consumed = true;
    }
    const waiterIndex = this.waiters.findIndex(
      (waiter) => waiter.matches && (frame.type === "protocolError" || waiter.matches(frame)),
    );
    const waiter =
      waiterIndex >= 0
        ? this.waiters.splice(waiterIndex, 1)[0]
        : this.waiters.find((candidate) => candidate.matches === undefined);
    if (waiter && waiter.matches === undefined) {
      const index = this.waiters.indexOf(waiter);
      if (index >= 0) this.waiters.splice(index, 1);
    }
    if (waiter) {
      waiter.resolve(frame);
      return undefined;
    }
    if (consumed) return undefined;
    // PTY consumers install listeners/waiters before dispatch. Unclaimed late frames
    // belong to retired observations; output/exit are recovered from agent replay.
    // Unsolicited 1.9 lifecycle frames are advisory: notices are replayable from the host ring,
    // activity and resource reports are superseded by the next one. Nobody requests them, so
    // keeping them could only fill the unclaimed set and close the connection.
    if (DROPPED_WHEN_UNCLAIMED.has(frame.type)) return undefined;
    if (this.unclaimed.length >= this.capacity) {
      return new RemoteAgentProtocolDecodeError(
        `more than ${this.capacity} unclaimed frames are waiting; the connection was closed`,
      );
    }
    this.unclaimed.push(frame);
    return undefined;
  }

  /** The first unclaimed frame `matches` accepts (a protocol error always matches). */
  takeUnclaimed(matches: (frame: RemoteAgentFrame) => boolean): RemoteAgentFrame | undefined {
    const index = this.unclaimed.findIndex(
      (frame) => frame.type === "protocolError" || matches(frame),
    );
    return index >= 0 ? this.unclaimed.splice(index, 1)[0] : undefined;
  }

  /** For `nextFrame()` without a matcher: the first frame no pending waiter would claim. */
  takeUnwaited(): RemoteAgentFrame | undefined {
    const index = this.unclaimed.findIndex(
      (frame) =>
        !this.waiters.some(
          (waiter) => waiter.matches && (frame.type === "protocolError" || waiter.matches(frame)),
        ),
    );
    return index >= 0 ? this.unclaimed.splice(index, 1)[0] : undefined;
  }

  rejectWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}
