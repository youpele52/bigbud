import { Terminal } from "@xterm/headless";
import { SerializeAddon, Unicode11Addon } from "./TerminalRecoveryModel.addons.mjs";
import { activateTerminalUnicodeProvider } from "@bigbud/shared/terminalUnicodeProvider";
import { attachRecoverySupplements } from "./TerminalRecoveryModel.supplements";
import { serializeRecoverySavedCursor } from "./TerminalRecoveryModel.savedCursor";
import { TerminalRecoveryQueries } from "./TerminalRecoveryModel.queries";
import { makeRecoveryCombinationAdmission } from "./TerminalRecoveryModel.combinations";
import {
  hasRecoveryImageState,
  hasPendingRecoveryImageCommand,
} from "./TerminalRecoveryModel.images";
import { sanitizeTerminalHistoryChunk } from "./Manager.history";
import { TerminalRecoveryRecords, type TerminalRecoveryOperation } from "./TerminalRecoveryRecords";
import {
  RECOVERY_PENDING_BYTES,
  RECOVERY_SCROLLBACK_ROWS,
  RECOVERY_SNAPSHOT_BYTES,
  reserveRecoveryModel,
} from "./TerminalRecoveryModel.budget";

export interface TerminalRecoveryFrame {
  readonly generation: string;
  readonly sequence: number;
  readonly cols: number;
  readonly rows: number;
  readonly ansi: string;
  readonly pendingEscapeTail: string;
  readonly scrollbackRows: number;
}
export type TerminalRecoveryCapture =
  | { readonly type: "candidate"; readonly frame: TerminalRecoveryFrame }
  | { readonly type: "unavailable"; readonly reason: string };
type Work =
  | { operation: TerminalRecoveryOperation; bytes: number }
  | { capture: (result: TerminalRecoveryCapture) => void };

/** Backend-owned recovery model. No PTY input sink: the live renderer remains query authority. */
export class TerminalRecoveryModel {
  readonly records: TerminalRecoveryRecords;
  private readonly terminal: Terminal;
  private readonly serializer = new SerializeAddon();
  private readonly supplements: ReturnType<typeof attachRecoverySupplements>;
  private queue: Work[] = [];
  private queuedBytes = 0;
  private running = false;
  private reason: string | null = null;
  private pendingEscapeTail = "";
  private pendingUnicodeContinuation = false;
  private imageStateUnsupported = false;
  private retiredMirrorReason: string | null = null;
  private readonly queries = new TerminalRecoveryQueries();
  private ingressSequence = 0;
  private parsingSequence = 0;
  private readonly queryListener: { dispose(): void };
  private readonly admitCombinations: (data: string) => boolean;
  private pendingCapture: Promise<TerminalRecoveryCapture> | null = null;
  private producerHeld = false;
  private cancelWrite: (() => void) | null = null;

  constructor(
    generation: string,
    cols: number,
    rows: number,
    private release: () => void,
    private readonly holdProducer: (held: boolean) => void = () => undefined,
  ) {
    this.records = new TerminalRecoveryRecords(generation);
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: RECOVERY_SCROLLBACK_ROWS,
      allowProposedApi: true,
      cursorBlink: true,
      logLevel: "off",
    });
    try {
      this.terminal.loadAddon(this.serializer);
      this.terminal.loadAddon(new Unicode11Addon());
      activateTerminalUnicodeProvider(this.terminal);
      this.admitCombinations = makeRecoveryCombinationAdmission(this.terminal);
      this.supplements = attachRecoverySupplements(this.terminal, (prefix) =>
        this.queries.expect(prefix, this.parsingSequence, true),
      );
      this.queryListener = this.terminal.onData((data) => {
        // Headless embeds a different version label than the matching browser build.
        // Match XTVERSION's response family, never substitute the mirror's answer.
        const version = data.startsWith("\x1bP>|");
        this.queries.expect(version ? "\x1bP>|" : data, this.parsingSequence, version);
      });
    } catch (error) {
      this.terminal.dispose();
      throw error;
    }
  }

  get unavailableReason(): string | null {
    return this.reason;
  }

  get inputCut(): number {
    return this.ingressSequence;
  }
  observeInput(data: string, sequence = this.ingressSequence): void {
    if (!this.reason) this.queries.observe(data, sequence);
  }

  /** Queues in ingress order, before manager output batching can cross a successful resize. */
  write(data: string): void {
    if (this.reason || data.length === 0) return;
    if (
      this.queuedBytes + data.length * 2 > RECOVERY_PENDING_BYTES ||
      this.queue.length + Math.ceil(data.length / (32 * 1024)) > 4096
    ) {
      this.dispose("unparsed-output-budget");
      return;
    }
    for (let offset = 0; offset < data.length; offset += 32 * 1024) {
      const chunk = data.slice(offset, offset + 32 * 1024);
      const bytes = chunk.length * 2;
      this.queue.push({ operation: { type: "output", data: chunk }, bytes });
      this.ingressSequence++;
      this.queuedBytes += bytes;
    }
    this.updatePressure();
    this.start();
  }

  /** Only call after native resize succeeds. Reserving first avoids allocating beyond admission. */
  resize(cols: number, rows: number): void {
    if (this.reason) return;
    if (this.queue.length >= 4096 || this.queuedBytes + 64 > RECOVERY_PENDING_BYTES) {
      this.dispose("unparsed-operation-budget");
      return;
    }
    this.queue.push({ operation: { type: "resize", cols, rows }, bytes: 64 });
    this.ingressSequence++;
    this.queuedBytes += 64;
    this.updatePressure();
    this.start();
  }

  /** Fixed FIFO cut; later writes cannot delay this capture. Concurrent callers share one cut. */
  capture(): Promise<TerminalRecoveryCapture> {
    if (this.reason) return Promise.resolve({ type: "unavailable", reason: this.reason });
    if (this.pendingCapture) return this.pendingCapture;
    const promise = new Promise<TerminalRecoveryCapture>((resolve) =>
      this.queue.push({ capture: resolve }),
    );
    this.pendingCapture = promise;
    void promise.then(() => {
      if (this.pendingCapture === promise) this.pendingCapture = null;
    });
    this.start();
    return promise;
  }

  private start(): void {
    if (this.running || this.reason) return;
    this.running = true;
    void this.drain()
      .catch(() => this.dispose("model-operation-failed"))
      .finally(() => {
        this.running = false;
        if (this.queue.length && !this.reason) this.start();
      });
  }

  private updatePressure(): void {
    // Leave ample bounded headroom for already-in-flight native callbacks after pause().
    const held =
      !this.reason &&
      (this.producerHeld
        ? this.queuedBytes > 128 * 1024 || this.queue.length > 256
        : this.queuedBytes >= 512 * 1024 || this.queue.length >= 1024);
    if (held === this.producerHeld) return;
    this.producerHeld = held;
    try {
      this.holdProducer(held);
    } catch {
      if (!this.reason) this.dispose("producer-flow-control-failed");
    }
  }

  private retireCapture(reason: string): void {
    if (this.retiredMirrorReason) return;
    this.retiredMirrorReason = reason;
    this.supplements.dispose();
    this.queryListener.dispose();
    this.terminal.dispose();
    this.pendingEscapeTail = "";
  }

  private async drain(): Promise<void> {
    while (this.queue.length && !this.reason) {
      const work = this.queue.shift()!;
      if ("capture" in work) {
        // Snapshot failure must settle this waiter too, not only remaining queued captures.
        try {
          work.capture(this.snapshot());
        } catch {
          this.dispose("snapshot-failed");
          work.capture({ type: "unavailable", reason: "snapshot-failed" });
        }
        continue;
      }
      const operation = work.operation;
      // Grid and journal admission bound ordinary redraws independently of session lifetime.
      // Combining admission remains conservative and is NOT qualified for default-on rollout.
      const retirement =
        operation.type === "output" &&
        !this.retiredMirrorReason &&
        !this.admitCombinations(operation.data)
          ? "unicode-combination-budget"
          : null;
      if (!this.retiredMirrorReason && retirement) {
        this.retireCapture(retirement);
      }
      if (this.retiredMirrorReason) {
        this.queuedBytes -= work.bytes;
        this.records.append(operation);
        this.updatePressure();
        continue;
      }
      if (operation.type === "output") {
        const scanned = sanitizeTerminalHistoryChunk(this.pendingEscapeTail, operation.data);
        if (hasRecoveryImageState(scanned.visibleText)) {
          // Existing recovered renderers still consume the ordered raw suffix. Only future
          // snapshots are refused: an unsupported image must not strand a healthy live view.
          this.imageStateUnsupported = true;
        }
        const tail = scanned.pendingControlSequence;
        if (tail.length > 16 * 1024) {
          this.retireCapture("parser-tail-budget");
        } else {
          this.parsingSequence = this.records.cursor.sequence + 1;
          await this.parse(operation.data);
          if (this.reason) return;
          this.pendingEscapeTail = tail;
          const last = operation.data.charCodeAt(operation.data.length - 1);
          this.pendingUnicodeContinuation = last === 0x200d || (last >= 0xd800 && last <= 0xdbff);
        }
      } else if (operation.cols !== this.terminal.cols || operation.rows !== this.terminal.rows) {
        const reservation = reserveRecoveryModel(operation.cols, operation.rows);
        if (!reservation) {
          this.retireCapture("resize-admission");
        } else {
          this.release();
          this.release = reservation;
          this.terminal.resize(operation.cols, operation.rows);
        }
      }
      this.queuedBytes -= work.bytes;
      this.records.append(operation);
      this.updatePressure();
    }
  }

  private parse(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.cancelWrite = null;
        resolve();
      };
      const timer = setTimeout(() => {
        this.dispose("parse-timeout");
        finish();
      }, 5000);
      timer.unref();
      this.cancelWrite = finish;
      try {
        this.terminal.write(data, finish);
      } catch (error) {
        clearTimeout(timer);
        this.cancelWrite = null;
        reject(error);
      }
    });
  }

  private snapshot(): TerminalRecoveryCapture {
    if (this.retiredMirrorReason) return { type: "unavailable", reason: this.retiredMirrorReason };
    if (this.queries.pending) return { type: "unavailable", reason: "pending-renderer-query" };
    if (this.imageStateUnsupported)
      return { type: "unavailable", reason: "image-state-not-supported" };
    if (hasPendingRecoveryImageCommand(this.pendingEscapeTail))
      return { type: "unavailable", reason: "image-command-pending" };
    if (this.pendingUnicodeContinuation)
      return { type: "unavailable", reason: "unicode-continuation-not-qualified" };
    const supplements = this.supplements.capture();
    if (supplements.unsupported) return { type: "unavailable", reason: supplements.unsupported };
    const buffer = this.terminal.buffer.active;
    // Stock serialization restores a relative cursor; full-screen pi/OpenCode probes expose
    // a one-column error. Absolute placement is safe here only outside origin/wrap-pending state.
    if (this.terminal.modes.originMode || buffer.cursorX >= this.terminal.cols)
      return { type: "unavailable", reason: "cursor-state-not-qualified" };
    const serialized = serializeRecoverySavedCursor(this.terminal, this.serializer.serialize());
    if (serialized === null) return { type: "unavailable", reason: "saved-cursor-not-qualified" };
    const ansi =
      serialized + supplements.ansi + `\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}H`;
    if (ansi.length * 2 > RECOVERY_SNAPSHOT_BYTES)
      return { type: "unavailable", reason: "snapshot-budget" };
    return {
      type: "candidate",
      frame: {
        ...this.records.cursor,
        cols: this.terminal.cols,
        rows: this.terminal.rows,
        ansi,
        pendingEscapeTail: this.pendingEscapeTail,
        scrollbackRows: Math.max(0, this.terminal.buffer.normal.length - this.terminal.rows),
      },
    };
  }

  /** Invalidates the mirror only; cannot stop, restart or send input to its process. */
  dispose(reason = "disposed"): void {
    if (this.reason) return;
    this.reason = reason;
    this.updatePressure();
    this.cancelWrite?.();
    if (!this.retiredMirrorReason) {
      this.supplements.dispose();
      this.queryListener.dispose();
      this.terminal.dispose();
    }
    this.records.dispose();
    this.release();
    for (const work of this.queue)
      if ("capture" in work) work.capture({ type: "unavailable", reason });
    this.queue = [];
    this.queuedBytes = 0;
  }
}

/** Explicit experimental opt-in until sustained Unicode/resource admission is qualified. */
export function createTerminalRecoveryModel(
  generation: string,
  cols: number,
  rows: number,
  holdProducer?: (held: boolean) => void,
): TerminalRecoveryModel | undefined {
  if (
    process.env.BIGBUD_TERMINAL_RECOVERY === "0" ||
    process.env.BIGBUD_TERMINAL_RECOVERY_SHADOW === "0"
  )
    return undefined;
  if (
    process.env.BIGBUD_TERMINAL_RECOVERY !== "1" &&
    process.env.BIGBUD_TERMINAL_RECOVERY_SHADOW !== "1"
  )
    return undefined;
  const release = reserveRecoveryModel(cols, rows);
  if (!release) return undefined;
  try {
    return new TerminalRecoveryModel(generation, cols, rows, release, holdProducer);
  } catch {
    release();
    return undefined;
  }
}
