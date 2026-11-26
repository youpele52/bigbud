/**
 * Chunked host screen snapshots (protocol 1.9, frames 80-82; plan §8.4, §9.1).
 *
 * A header names the transfer's chunk count, byte total and SHA-256; chunks follow in index
 * order. Reassembly is bounded: one preallocated buffer of at most 3 MiB per transfer and at most
 * {@link REMOTE_AGENT_SNAPSHOT_MAX_IN_FLIGHT} transfers per connection, so one connection never
 * holds more than 2 x 3 MiB. Out-of-order, duplicate, oversize or mismatched chunks abandon the
 * transfer; so does silence for 5 s. Each abandoned transfer is retried once.
 *
 * @module remoteAgentPtyClient.screen
 */
import { createHash, randomUUID, type Hash } from "node:crypto";
import type { PtyScreenSnapshot, PtyScreenSnapshotInput } from "../terminal/Services/PTY.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import {
  REMOTE_AGENT_LIFECYCLE_UNSUPPORTED,
  REMOTE_AGENT_SNAPSHOT_BUSY,
  REMOTE_AGENT_SNAPSHOT_CHUNK_MAX_BYTES,
  REMOTE_AGENT_SNAPSHOT_DEFAULT_MAX_ANSI_UNITS,
  REMOTE_AGENT_SNAPSHOT_MAX_CHUNKS,
  REMOTE_AGENT_SNAPSHOT_MAX_ESCAPE_TAIL_BYTES,
  REMOTE_AGENT_SNAPSHOT_MAX_TOTAL_BYTES,
  REMOTE_AGENT_TERMINAL_SCREEN_CAPABILITY,
  type RemoteAgentPtyScreenSnapshotChunk,
  type RemoteAgentPtyScreenSnapshotHeader,
} from "./remoteAgentProtocol.ptyLifecycle.ts";
import { RemoteAgentPtyError } from "./remoteAgentPtyClient.types.ts";

/** Matches the agent's semaphore; the client enforces the same bound per connection. */
export const REMOTE_AGENT_SNAPSHOT_MAX_IN_FLIGHT = 2;
/** Callers beyond this many waiting for a transfer slot fail with `SNAPSHOT_BUSY`. */
export const REMOTE_AGENT_SNAPSHOT_MAX_QUEUED = 32;
export const REMOTE_AGENT_SNAPSHOT_TRANSFER_TIMEOUT_MS = 5_000;
export const REMOTE_AGENT_SNAPSHOT_BUSY_RETRY_MS = 250;
export const REMOTE_AGENT_SNAPSHOT_BUSY_RETRIES = 8;

/** Test seam for the busy back-off; production waits the protocol's 250 ms. */
export const remoteAgentScreenTiming: { delay?: (ms: number) => Promise<void> } = {};

const invalid = (message: string) => new RemoteAgentPtyError("SNAPSHOT_INVALID", message);
const FIDELITIES = new Set(["full", "trimmed", "partial"]);
const MODEL_STATES = new Set(["live", "cold", "invalid"]);
const isCount = (value: number, min = 0) => Number.isSafeInteger(value) && value >= min;

/** One transfer's validation and reassembly. Throws `SNAPSHOT_INVALID` on any violation. */
export class RemoteAgentScreenAssembly {
  private readonly buffer: Uint8Array;
  private readonly hash: Hash = createHash("sha256");
  private nextIndex = 0;
  private received = 0;
  private result: PtyScreenSnapshot | undefined;

  constructor(
    private readonly header: RemoteAgentPtyScreenSnapshotHeader,
    ptyId: string,
  ) {
    const { chunkCount, totalAnsiBytes } = header;
    if (header.ptyId !== ptyId) throw invalid("Snapshot belongs to another terminal.");
    if (!isCount(chunkCount) || chunkCount > REMOTE_AGENT_SNAPSHOT_MAX_CHUNKS)
      throw invalid(`Snapshot chunk count ${chunkCount} is out of range.`);
    if (
      !isCount(totalAnsiBytes) ||
      totalAnsiBytes > REMOTE_AGENT_SNAPSHOT_MAX_TOTAL_BYTES ||
      totalAnsiBytes > chunkCount * REMOTE_AGENT_SNAPSHOT_CHUNK_MAX_BYTES
    )
      throw invalid(`Snapshot size ${totalAnsiBytes} is out of range.`);
    if (header.pendingEscapeTail.length > REMOTE_AGENT_SNAPSHOT_MAX_ESCAPE_TAIL_BYTES)
      throw invalid("Snapshot escape tail is too large.");
    if (header.sha256.length !== 32) throw invalid("Snapshot digest is malformed.");
    if (!FIDELITIES.has(header.fidelity) || !MODEL_STATES.has(header.modelState))
      throw invalid("Snapshot fidelity or model state is unknown.");
    if (!isCount(header.throughSequence) || !isCount(header.cols, 1) || !isCount(header.rows, 1))
      throw invalid("Snapshot geometry or sequence is malformed.");
    this.buffer = new Uint8Array(totalAnsiBytes);
    if (chunkCount === 0) this.complete();
  }

  get snapshot(): PtyScreenSnapshot | undefined {
    return this.result;
  }

  /** Returns the snapshot once the last chunk verified. */
  accept(chunk: RemoteAgentPtyScreenSnapshotChunk): PtyScreenSnapshot | undefined {
    if (this.result) throw invalid(`Snapshot chunk ${chunk.index} arrived after the last chunk.`);
    if (chunk.index !== this.nextIndex)
      throw invalid(
        chunk.index < this.nextIndex
          ? `Snapshot chunk ${chunk.index} is a duplicate.`
          : `Expected snapshot chunk ${this.nextIndex}, received ${chunk.index}.`,
      );
    const size = chunk.bytes.length;
    if (size > REMOTE_AGENT_SNAPSHOT_CHUNK_MAX_BYTES || this.received + size > this.buffer.length)
      throw invalid(`Snapshot chunk ${chunk.index} is oversize.`);
    if (chunk.last !== (chunk.index === this.header.chunkCount - 1))
      throw invalid(`Snapshot chunk ${chunk.index} disagrees with the chunk count.`);
    this.buffer.set(chunk.bytes, this.received);
    this.hash.update(chunk.bytes);
    this.received += size;
    this.nextIndex += 1;
    if (chunk.last) this.complete();
    return this.result;
  }

  private complete(): void {
    if (this.received !== this.buffer.length) throw invalid("Snapshot is shorter than declared.");
    if (!Buffer.from(this.header.sha256).equals(this.hash.digest()))
      throw invalid("Snapshot digest does not match.");
    const header = this.header;
    this.result = {
      throughSequence: header.throughSequence,
      cols: header.cols,
      rows: header.rows,
      scrollbackRows: header.scrollbackRows,
      alternateScreen: header.alternateScreen,
      fidelity: header.fidelity as PtyScreenSnapshot["fidelity"],
      modelState: header.modelState as PtyScreenSnapshot["modelState"],
      trimmedRows: header.trimmedRows,
      ansi: this.buffer,
      pendingEscapeTail: header.pendingEscapeTail,
    };
  }
}

type TransferOutcome =
  | { readonly kind: "snapshot"; readonly snapshot: PtyScreenSnapshot }
  | { readonly kind: "refused"; readonly code: string; readonly message: string };

class SnapshotTransfer {
  private assembly: RemoteAgentScreenAssembly | undefined;
  readonly done: Promise<TransferOutcome>;
  private settle!: (outcome: TransferOutcome) => void;
  private fail!: (error: Error) => void;

  constructor(private readonly ptyId: string) {
    this.done = new Promise((resolve, reject) => {
      this.settle = resolve;
      this.fail = reject;
    });
    void this.done.catch(() => undefined);
  }

  abandon(error: Error): void {
    this.fail(error);
  }

  header(header: RemoteAgentPtyScreenSnapshotHeader): void {
    if (this.assembly) return this.fail(invalid("Snapshot header was repeated."));
    if (!header.accepted)
      return this.settle({ kind: "refused", code: header.errorCode, message: header.errorMessage });
    try {
      this.assembly = new RemoteAgentScreenAssembly(header, this.ptyId);
      if (this.assembly.snapshot)
        this.settle({ kind: "snapshot", snapshot: this.assembly.snapshot });
    } catch (error) {
      this.fail(error as Error);
    }
  }

  chunk(chunk: RemoteAgentPtyScreenSnapshotChunk): void {
    if (!this.assembly) return this.fail(invalid("Snapshot chunk arrived before its header."));
    try {
      const snapshot = this.assembly.accept(chunk);
      if (snapshot) this.settle({ kind: "snapshot", snapshot });
    } catch (error) {
      this.fail(error as Error);
    }
  }
}

/** Per-connection slot bound plus the router that owns every snapshot header and chunk frame. */
class SnapshotChannel {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly transfers = new Map<string, SnapshotTransfer>();

  constructor(private readonly connection: RemoteAgentConnection) {
    connection.onFrame((frame) => this.route(frame));
  }

  get inFlight(): number {
    return this.active;
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active >= REMOTE_AGENT_SNAPSHOT_MAX_IN_FLIGHT) {
      if (this.queue.length >= REMOTE_AGENT_SNAPSHOT_MAX_QUEUED)
        throw new RemoteAgentPtyError(REMOTE_AGENT_SNAPSHOT_BUSY, "Too many screen copies queued.");
      await new Promise<void>((resolve, reject) => {
        const grant = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          const index = this.queue.indexOf(grant);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal.reason);
        };
        this.queue.push(grant);
        signal.addEventListener("abort", abort, { once: true });
      });
    } else this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      // The slot passes straight to the next waiter, so the count never exceeds the bound.
      if (next) next();
      else this.active -= 1;
    };
  }

  async transfer(
    ptyId: string,
    input: PtyScreenSnapshotInput,
    signal: AbortSignal,
  ): Promise<TransferOutcome> {
    const requestId = randomUUID();
    const transfer = new SnapshotTransfer(ptyId);
    const timeout = AbortSignal.timeout(REMOTE_AGENT_SNAPSHOT_TRANSFER_TIMEOUT_MS);
    const bounded = AbortSignal.any([signal, timeout]);
    const abort = () =>
      transfer.abandon(
        signal.aborted
          ? (signal.reason as Error)
          : new RemoteAgentPtyError("SNAPSHOT_TIMEOUT", "The screen copy timed out."),
      );
    bounded.addEventListener("abort", abort, { once: true });
    this.transfers.set(requestId, transfer);
    try {
      // Armed before sending: the header and chunks can arrive in one synchronous read.
      const header = this.connection.request(
        {
          type: "ptyScreenSnapshotRequest",
          value: {
            requestId,
            ptyId,
            maxAnsiUnits: input.maxAnsiUnits ?? REMOTE_AGENT_SNAPSHOT_DEFAULT_MAX_ANSI_UNITS,
            maxUtf8Bytes: input.maxUtf8Bytes ?? REMOTE_AGENT_SNAPSHOT_MAX_TOTAL_BYTES,
            maxScrollbackRows: input.maxScrollbackRows ?? 0,
            attachRenderer: input.attachRenderer,
          },
        },
        (frame) => frame.type === "ptyScreenSnapshotHeader" && frame.value.requestId === requestId,
        bounded,
      );
      void header.catch((error: unknown) => transfer.abandon(error as Error));
      return await transfer.done;
    } finally {
      bounded.removeEventListener("abort", abort);
      this.transfers.delete(requestId);
    }
  }

  private route(frame: RemoteAgentFrame): boolean {
    if (frame.type !== "ptyScreenSnapshotHeader" && frame.type !== "ptyScreenSnapshotChunk")
      return false;
    const transfer = this.transfers.get(frame.value.requestId);
    if (frame.type === "ptyScreenSnapshotHeader") transfer?.header(frame.value);
    else transfer?.chunk(frame.value);
    // Late frames of abandoned or finished transfers are dropped, never left unclaimed.
    return true;
  }
}

const channels = new WeakMap<RemoteAgentConnection, SnapshotChannel>();

function channelFor(connection: RemoteAgentConnection): SnapshotChannel {
  let channel = channels.get(connection);
  if (!channel) {
    channel = new SnapshotChannel(connection);
    channels.set(connection, channel);
  }
  return channel;
}

/** Transfers currently holding a slot on this connection (diagnostics and tests). */
export function remoteAgentSnapshotsInFlight(connection: RemoteAgentConnection): number {
  return channels.get(connection)?.inFlight ?? 0;
}

const delay = (ms: number, signal: AbortSignal) =>
  remoteAgentScreenTiming.delay?.(ms) ??
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

function validateInput(input: PtyScreenSnapshotInput): void {
  const { maxAnsiUnits, maxUtf8Bytes, maxScrollbackRows } = input;
  if (
    (maxAnsiUnits !== undefined &&
      (!isCount(maxAnsiUnits) || maxAnsiUnits > REMOTE_AGENT_SNAPSHOT_DEFAULT_MAX_ANSI_UNITS)) ||
    (maxUtf8Bytes !== undefined &&
      (!isCount(maxUtf8Bytes) || maxUtf8Bytes > REMOTE_AGENT_SNAPSHOT_MAX_TOTAL_BYTES)) ||
    (maxScrollbackRows !== undefined && !isCount(maxScrollbackRows))
  )
    throw new RangeError("Screen copy limits exceed the protocol caps.");
}

/**
 * Requests one verified screen copy. Old agents (no terminal.screen) get nothing on the wire and
 * the call rejects with `UNSUPPORTED`. `SNAPSHOT_BUSY` is retried every 250 ms (8 times); an
 * invalid or timed-out transfer is retried once. Other refusals reject with the host's code.
 */
export async function requestRemoteAgentScreenSnapshot(
  connection: RemoteAgentConnection,
  ptyId: string,
  input: PtyScreenSnapshotInput,
  parentSignal?: AbortSignal,
): Promise<PtyScreenSnapshot> {
  validateInput(input);
  if (!connection.supportsCapability?.(REMOTE_AGENT_TERMINAL_SCREEN_CAPABILITY))
    throw new RemoteAgentPtyError(
      REMOTE_AGENT_LIFECYCLE_UNSUPPORTED,
      "This terminal host cannot provide screen copies.",
    );
  const signals = [input.signal, parentSignal].filter((s): s is AbortSignal => s !== undefined);
  const signal = signals.length > 0 ? AbortSignal.any(signals) : new AbortController().signal;
  const channel = channelFor(connection);
  const release = await channel.acquire(signal);
  try {
    let busyRetries = REMOTE_AGENT_SNAPSHOT_BUSY_RETRIES;
    let transferRetries = 1;
    for (;;) {
      let outcome: TransferOutcome;
      try {
        outcome = await channel.transfer(ptyId, input, signal);
      } catch (error) {
        const retryable =
          error instanceof RemoteAgentPtyError &&
          (error.code === "SNAPSHOT_INVALID" || error.code === "SNAPSHOT_TIMEOUT");
        if (!retryable || signal.aborted || transferRetries-- <= 0) throw error;
        continue;
      }
      if (outcome.kind === "snapshot") return outcome.snapshot;
      if (outcome.code === REMOTE_AGENT_SNAPSHOT_BUSY && busyRetries-- > 0) {
        await delay(REMOTE_AGENT_SNAPSHOT_BUSY_RETRY_MS, signal);
        continue;
      }
      throw new RemoteAgentPtyError(
        outcome.code || "SNAPSHOT_REFUSED",
        outcome.message || "The terminal host refused the screen copy.",
      );
    }
  } finally {
    release();
  }
}
