import { createHash } from "node:crypto";
import { RemoteAgentFrameInbox } from "./remoteAgentConnection.inbox.ts";
import { requestRemoteFrame } from "./remoteAgentConnection.request.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import type { RemoteAgentPtyScreenSnapshotHeader } from "./remoteAgentProtocol.ptyLifecycle.ts";

export const ALL_LIFECYCLE_CAPABILITIES = [
  "terminal.pty",
  "terminal.screen",
  "terminal.lifecycle",
  "terminal.spool",
  "terminal.query-responder",
  "terminal.local-launch",
];

type FrameValues = {
  [K in RemoteAgentFrame["type"]]: Extract<RemoteAgentFrame, { type: K }>["value"];
};

/** A connection fake that routes frames through the real inbox and request waiter logic. */
export class FakeLifecycleConnection {
  readonly inbox = new RemoteAgentFrameInbox();
  readonly sent: RemoteAgentFrame[] = [];
  onSend: ((frame: RemoteAgentFrame) => void) | undefined;
  private readonly capabilities: Set<string>;

  constructor(capabilities: ReadonlyArray<string> = ALL_LIFECYCLE_CAPABILITIES) {
    this.capabilities = new Set(capabilities);
  }

  get asConnection(): RemoteAgentConnection {
    return this as unknown as RemoteAgentConnection;
  }

  supportsCapability(name: string): boolean {
    return this.capabilities.has(name);
  }

  onFrame(listener: (frame: RemoteAgentFrame) => boolean | void): () => void {
    this.inbox.listeners.add(listener);
    return () => this.inbox.listeners.delete(listener);
  }

  onFailure(): () => void {
    return () => undefined;
  }

  request(
    frame: RemoteAgentFrame,
    matches: (frame: RemoteAgentFrame) => boolean,
    signal?: AbortSignal,
  ): Promise<RemoteAgentFrame> {
    const queued = this.inbox.takeUnclaimed(matches);
    if (queued) return Promise.resolve(queued);
    return requestRemoteFrame(
      this.inbox.waiters,
      async () => {
        this.sent.push(frame);
        this.onSend?.(frame);
      },
      matches,
      signal,
    );
  }

  deliver(frame: RemoteAgentFrame): void {
    const overflow = this.inbox.deliver(frame);
    if (overflow) throw overflow;
  }

  sentOfType<T extends RemoteAgentFrame["type"]>(type: T): Array<FrameValues[T]> {
    const values: unknown[] = this.sent
      .filter((frame) => frame.type === type)
      .map((frame) => frame.value);
    return values as Array<FrameValues[T]>;
  }
}

export function snapshotHeader(
  requestId: string,
  ansi: Uint8Array,
  chunkCount: number,
  overrides: Partial<RemoteAgentPtyScreenSnapshotHeader> = {},
): RemoteAgentPtyScreenSnapshotHeader {
  return {
    requestId,
    ptyId: "pty-1",
    accepted: true,
    errorCode: "",
    errorMessage: "",
    throughSequence: 41,
    cols: 120,
    rows: 40,
    scrollbackRows: 12,
    alternateScreen: false,
    fidelity: "full",
    modelState: "live",
    chunkCount,
    totalAnsiBytes: ansi.length,
    pendingEscapeTail: new Uint8Array([0x1b]),
    sha256: createHash("sha256").update(ansi).digest(),
    trimmedRows: 0,
    ...overrides,
  };
}

/** The header and in-order chunks of one transfer. */
export function snapshotFrames(
  requestId: string,
  ansi: Uint8Array,
  chunkSize: number,
  overrides: Partial<RemoteAgentPtyScreenSnapshotHeader> = {},
): RemoteAgentFrame[] {
  const chunkCount = Math.ceil(ansi.length / chunkSize);
  const frames: RemoteAgentFrame[] = [
    {
      type: "ptyScreenSnapshotHeader",
      value: snapshotHeader(requestId, ansi, chunkCount, overrides),
    },
  ];
  for (let index = 0; index < chunkCount; index += 1)
    frames.push({
      type: "ptyScreenSnapshotChunk",
      value: {
        requestId,
        index,
        last: index === chunkCount - 1,
        bytes: ansi.subarray(index * chunkSize, (index + 1) * chunkSize),
      },
    });
  return frames;
}

export const bytesOf = (length: number, seed = 7): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => (index * 31 + seed) % 251);
