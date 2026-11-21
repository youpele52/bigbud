/**
 * Screen restore for host-backed sessions (plan §8.9, §9.1, D3). A subscriber that passes
 * `acceptScreen` gets the host's screen copy first after `subscribed`, then live output cut at
 * the snapshot's `through_sequence`: output at or below it is already in the screen and is
 * dropped, so nothing is shown twice and nothing is lost. The snapshot is requested with
 * `attach_renderer = true`, which atomically moves the host query-responder cut to it.
 *
 * Transfers are bounded by the server client (at most 2 in flight per host connection, with
 * `SNAPSHOT_BUSY` retries, `remoteAgentPtyClient.screen.ts`).
 *
 * @module Manager.hostScreen
 */
import type { TerminalEvent } from "@bigbud/contracts";
import {
  TERMINAL_RECOVERY_ANSI_MAX_CHARS,
  TERMINAL_RECOVERY_TAIL_MAX_CHARS,
} from "@bigbud/contracts/workspace/terminal.recovery.ts";
import type { TerminalScreenItem } from "@bigbud/contracts/workspace/terminal.stream.ts";

import type { PtyScreenSnapshot } from "../Services/PTY.ts";
import {
  terminalHostOutputEnd,
  type TerminalHostOutputLedger,
} from "./Manager.hostScreen.ledger.ts";

/** Output a subscriber buffers while its screen is being fetched; beyond it, it resyncs. */
export const TERMINAL_SCREEN_SPLICE_BUFFER_CHARS = 4 * 1024 * 1024;

const decoder = new TextDecoder();

/** A verified host snapshot as a contract screen item; `undefined` when it cannot be shown. */
export function terminalScreenItem(input: {
  readonly threadId: string;
  readonly terminalId: string;
  readonly runtimeGeneration: string;
  readonly snapshot: PtyScreenSnapshot;
}): TerminalScreenItem | undefined {
  const { snapshot } = input;
  if (snapshot.modelState === "invalid") return undefined;
  const ansi = decoder.decode(snapshot.ansi);
  const pendingEscapeTail = decoder.decode(snapshot.pendingEscapeTail);
  if (
    ansi.length > TERMINAL_RECOVERY_ANSI_MAX_CHARS ||
    pendingEscapeTail.length > TERMINAL_RECOVERY_TAIL_MAX_CHARS ||
    snapshot.cols < 1 ||
    snapshot.cols > 1000 ||
    snapshot.rows < 1 ||
    snapshot.rows > 500 ||
    !Number.isSafeInteger(snapshot.throughSequence) ||
    snapshot.throughSequence < 0
  )
    return undefined;
  return {
    type: "screen",
    threadId: input.threadId,
    terminalId: input.terminalId,
    runtimeGeneration: input.runtimeGeneration,
    throughSequence: String(snapshot.throughSequence),
    cols: snapshot.cols,
    rows: snapshot.rows,
    ansi,
    pendingEscapeTail,
    scrollbackRows: snapshot.scrollbackRows,
    alternateScreen: snapshot.alternateScreen,
    fidelity: snapshot.fidelity,
    cold: snapshot.modelState === "cold",
  };
}

/** What the splice needs to know about the session right now. */
export type TerminalScreenSource =
  /** No process (yet), or the session does not exist: wait for its start. */
  | { readonly kind: "pending" }
  /** A process without a host screen (node-pty, an old agent): stream live at once. */
  | { readonly kind: "none" }
  | {
      readonly kind: "host";
      readonly ledger: TerminalHostOutputLedger;
      readonly fetch: () => Promise<TerminalScreenItem | undefined>;
    };

export interface TerminalScreenSpliceSink {
  readonly screen: (item: TerminalScreenItem) => void;
  readonly event: (event: TerminalEvent) => void;
  /** The subscriber fell too far behind while its screen was fetched; it must resubscribe. */
  readonly overflow: () => void;
}

/**
 * One subscriber's ordered stream: buffered until its screen is known, then the screen (if
 * any), then live events with output at or below the cut removed.
 */
export class TerminalScreenSplice {
  private state: "idle" | "waiting" | "fetching" | "live" | "closed" = "idle";
  private readonly buffer: TerminalEvent[] = [];
  private bufferedChars = 0;
  private cutSequence: number | undefined;
  /** Highest output offset covered by the screen or already forwarded. */
  private floor: number | undefined;
  private screenGeneration: string | undefined;
  private ledger: TerminalHostOutputLedger | undefined;
  /** Absolute offset of the first output char forwarded live (for the acked sequence). */
  private baseChars: number | undefined;

  constructor(
    private readonly source: () => TerminalScreenSource,
    private readonly sink: TerminalScreenSpliceSink,
    private readonly options: { readonly acceptScreen: boolean; readonly waitForStart: boolean },
  ) {}

  /** Call once the subscriber may receive items (after `subscribed`). */
  start(): void {
    if (this.state !== "idle") return;
    this.state = "waiting";
    this.evaluate(undefined);
  }

  push(event: TerminalEvent): void {
    if (this.state === "closed") return;
    if (this.state === "live") {
      this.forward(event);
      return;
    }
    if (event.type === "output") {
      this.bufferedChars += event.data.length;
      if (this.bufferedChars > TERMINAL_SCREEN_SPLICE_BUFFER_CHARS) {
        this.close();
        this.sink.overflow();
        return;
      }
    }
    this.buffer.push(event);
    if (this.state === "waiting") this.evaluate(event);
  }

  close(): void {
    this.state = "closed";
    this.buffer.length = 0;
    this.bufferedChars = 0;
  }

  /** The newest host sequence this subscriber's view has parsed, given its acknowledged chars. */
  ackedSequence(acknowledgedChars: number): number | undefined {
    if (!this.ledger || this.baseChars === undefined) return undefined;
    return this.ledger.sequenceAtChars(this.baseChars + acknowledgedChars);
  }

  private evaluate(event: TerminalEvent | undefined): void {
    const source = this.source();
    if (source.kind === "host") this.ledger = source.ledger;
    // Without `acceptScreen` the stream is exactly the live stream, as before.
    if (!this.options.acceptScreen) {
      this.goLive();
      return;
    }
    if (source.kind === "host") {
      this.state = "fetching";
      void source.fetch().then(
        (item) => this.applyScreen(item),
        () => this.applyScreen(undefined),
      );
      return;
    }
    // Anything but output means the process will not (or did not) start with a host screen.
    const settled = event !== undefined && event.type !== "output";
    if (source.kind === "none" || !this.options.waitForStart || settled) this.goLive();
  }

  private applyScreen(item: TerminalScreenItem | undefined): void {
    if (this.state !== "fetching") return;
    if (item) {
      this.cutSequence = Number(item.throughSequence);
      this.screenGeneration = item.runtimeGeneration;
      this.sink.screen(item);
    }
    this.goLive();
  }

  private goLive(): void {
    if (this.state === "closed") return;
    this.state = "live";
    const pending = this.buffer.splice(0);
    this.bufferedChars = 0;
    for (const event of pending) this.forward(event);
  }

  private forward(event: TerminalEvent): void {
    if (event.type !== "output") {
      // A new process generation is outside the screen's sequence space.
      if (
        (event.type === "started" || event.type === "restarted") &&
        event.snapshot.runtimeGeneration !== this.screenGeneration
      ) {
        this.cutSequence = undefined;
        this.ledger = undefined;
        this.floor = undefined;
      }
      this.sink.event(event);
      return;
    }
    const end = terminalHostOutputEnd(event);
    if (end === undefined || this.ledger === undefined) {
      this.sink.event(event);
      return;
    }
    if (this.cutSequence !== undefined) {
      const cut = this.ledger.charsThrough(this.cutSequence);
      // The cut has not arrived yet: everything published so far is covered by the screen.
      if (cut === undefined) return;
      this.cutSequence = undefined;
      this.floor = Math.max(this.floor ?? 0, cut);
    }
    // Offsets only grow: anything at or below the floor was in the screen or already sent.
    const start = end - event.data.length;
    const floor = this.floor ?? start;
    if (end <= floor) return;
    this.baseChars ??= Math.max(start, floor);
    this.floor = end;
    this.sink.event(start < floor ? { ...event, data: event.data.slice(floor - start) } : event);
  }
}
