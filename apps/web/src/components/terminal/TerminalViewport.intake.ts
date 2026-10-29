import type {
  TerminalEvent,
  TerminalSessionSnapshot,
} from "@bigbud/contracts/workspace/terminal.ts";
import type { Terminal } from "@xterm/xterm";
import { TerminalWriteBatcher } from "./TerminalWriteBatcher";
import { TerminalHistoryUnavailableError } from "./TerminalHistoryUnavailableError";
import { reserveTerminalOutput, releaseTerminalOutput } from "./TerminalOutputBudget";

/** Bounded legacy hydration handoff, not a sequenced or exact checkpoint protocol. */
export class TerminalViewportIntake {
  private pending: TerminalEvent[] = [];
  private bytes = 0;
  /** Flow-control credit (output UTF-16 units) parked here, not yet parsed or discarded. */
  private pendingOutput = 0;
  private live = false;
  private disposed = false;
  private gate = 1;
  private opened = false;
  private cutoff: string | null = null;
  private baseline: TerminalSessionSnapshot | null = null;
  private hydration: Promise<void> | null = null;
  constructor(
    private readonly terminal: Terminal,
    private readonly lane: TerminalWriteBatcher,
    private readonly apply: (event: TerminalEvent) => void,
    private readonly onInputState: (enabled: boolean) => void,
    /** Parked output was discarded without parsing; the stream may acknowledge it now. */
    private readonly onCreditReleased: () => void = () => undefined,
    private readonly acceptSnapshot: (snapshot: TerminalSessionSnapshot) => boolean = () => true,
  ) {
    this.updateInput();
  }

  /** Parked output still counts as outstanding: acknowledging it early refills the server window. */
  get pendingOutputChars(): number {
    return this.pendingOutput;
  }

  private takePending(): TerminalEvent[] {
    const pending = this.pending;
    releaseTerminalOutput(this.bytes);
    this.pending = [];
    this.bytes = 0;
    this.pendingOutput = 0;
    return pending;
  }

  get acceptsInput(): boolean {
    return !this.disposed && !this.lane.isStopped && this.gate === 0;
  }
  get snapshotUpdatedAt(): string | null {
    return this.cutoff;
  }
  private updateInput(): void {
    this.terminal.options.disableStdin = !this.acceptsInput;
    this.onInputState(this.acceptsInput);
  }
  pause(error: Error): void {
    this.takePending();
    this.baseline = null;
    this.lane.pause(error);
    this.updateInput();
  }

  receive = (event: TerminalEvent): void => {
    if (this.disposed || this.lane.isStopped) return;
    if (event.type === "activity" || event.type === "agentIdentity") return;
    if (this.cutoff !== null && event.createdAt <= this.cutoff) return;
    if (
      (event.type === "started" || event.type === "restarted") &&
      !this.acceptSnapshot(event.snapshot)
    )
      return;
    if (!this.live && (event.type === "started" || event.type === "restarted")) {
      // Open publishes a started snapshot before its RPC response. Keep one
      // authoritative baseline, not a second history-sized live-queue item.
      this.stage(event.snapshot);
      this.apply(event);
      return;
    }
    if (this.live) {
      this.apply(event);
      return;
    }
    const bytes = this.eventBytes(event);
    if (
      this.bytes + bytes > 1024 * 1024 ||
      this.pending.length >= 4096 ||
      !reserveTerminalOutput(bytes)
    ) {
      this.pause(
        new Error(
          "Terminal hydration overflowed. Delivery and input are paused; no exact checkpoint is available.",
        ),
      );
      return;
    }
    this.pending.push(event);
    this.bytes += bytes;
    if (event.type === "output") this.pendingOutput += event.data.length;
  };

  private eventBytes(event: TerminalEvent): number {
    return event.type === "output" ? event.data.length * 3 : 1024;
  }

  /** The legacy server timestamps delimit snapshot coverage, not an exact checkpoint. */
  private stage(snapshot: TerminalSessionSnapshot): boolean {
    if (this.cutoff !== null && snapshot.updatedAt <= this.cutoff) return false;
    if (!this.acceptSnapshot(snapshot)) return false;
    this.cutoff = snapshot.updatedAt;
    this.baseline = snapshot;
    const retained = this.pending.filter((event) => event.createdAt > snapshot.updatedAt);
    const bytes = retained.reduce((sum, event) => sum + this.eventBytes(event), 0);
    const output = retained.reduce(
      (sum, event) => sum + (event.type === "output" ? event.data.length : 0),
      0,
    );
    const released = this.pendingOutput - output;
    releaseTerminalOutput(this.bytes - bytes);
    this.pending = retained;
    this.bytes = bytes;
    this.pendingOutput = output;
    // The snapshot covers the discarded output, so its credit is settled.
    if (released > 0) this.onCreditReleased();
    return true;
  }

  /** Stream lifecycle snapshots through the same serialized replay as initial open. */
  replay(snapshot: TerminalSessionSnapshot): void {
    if (this.disposed || this.lane.isStopped || !this.stage(snapshot) || !this.opened) return;
    this.live = false;
    void this.startHydration().catch((error: unknown) => {
      if (!this.disposed) this.pause(error instanceof Error ? error : new Error("Replay failed"));
    });
  }

  hydrate(snapshot: TerminalSessionSnapshot): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.opened = true;
    this.stage(snapshot);
    return this.startHydration();
  }

  private startHydration(): Promise<void> {
    if (this.hydration) return this.hydration;
    const run: Promise<void> = this.drainHistory().finally(() => {
      if (this.hydration === run) this.hydration = null;
      if (this.baseline && !this.disposed && !this.lane.isStopped) return this.startHydration();
    });
    this.hydration = run;
    return run;
  }

  private async drainHistory(): Promise<void> {
    while (this.baseline && !this.disposed) {
      const snapshot = this.baseline;
      this.baseline = null;
      if (snapshot.historyTruncated || snapshot.historyUnavailable) {
        this.pause(new TerminalHistoryUnavailableError());
        return;
      }
      this.live = false;
      // Already-queued live output may still contain valid protocol queries.
      this.lane.barrier(() => {
        this.gate = 1;
        this.updateInput();
      });
      this.lane.write(this.terminal, "\x1bc");
      for (let offset = 0; offset < snapshot.history.length; ) {
        let end = Math.min(offset + 8192, snapshot.history.length);
        const last = snapshot.history.charCodeAt(end - 1);
        if (end < snapshot.history.length && last >= 0xd800 && last <= 0xdbff) end--;
        this.lane.write(this.terminal, snapshot.history.slice(offset, end));
        await this.lane.whenIdle();
        if (this.disposed) return;
        if (this.baseline) break; // A newer baseline covers this replay and its older events.
        offset = end;
      }
      await this.lane.whenIdle();
      if (this.disposed) return;
      if (this.baseline) continue;
      // Applied output carries its credit into the write lane until xterm parses it.
      const pending = this.takePending();
      // History is parsed. Buffered post-snapshot bytes are LIVE, including
      // handshake queries: suppressing their replies can wedge a waiting TUI.
      this.live = true;
      this.lane.barrier(() => {
        this.gate = 0;
        this.updateInput();
      });
      for (const event of pending) this.apply(event);
      // A fixed FIFO fence, not an empty-queue poll: continuous output cannot starve it.
      await this.lane.whenIdle();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.takePending();
    this.baseline = null;
    this.updateInput();
  }
}
