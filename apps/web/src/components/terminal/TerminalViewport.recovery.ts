import type { Terminal } from "@xterm/xterm";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import type {
  TerminalRecoveryCursor,
  TerminalRecoveryInput,
  TerminalRecoveryResult,
} from "@bigbud/contracts/workspace/terminal.recovery.ts";
import { TerminalWriteBatcher } from "./TerminalWriteBatcher";
import { TerminalHistoryUnavailableError } from "./TerminalHistoryUnavailableError";
import { withTerminalViewDeadline } from "./terminalLifecycle.operations";
import { ownRecoveryGeometry } from "./terminalRecoveryGeometry";

export type TerminalRecoveryRequest = (
  input: TerminalRecoveryInput,
) => Promise<TerminalRecoveryResult>;

/** A recovered view consumes only sequenced model output, never the overlapping legacy stream. */
export class TerminalViewportRecovery {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cursor: TerminalRecoveryCursor | undefined;
  private identity: TerminalRecoveryInput | undefined;
  private resets = 0;
  private releaseGeometry: (() => void) | undefined;
  private idleDelay = 50;
  private polling = false;
  private notified = false;
  constructor(
    private readonly terminal: Terminal,
    private readonly lane: TerminalWriteBatcher,
    private readonly request: TerminalRecoveryRequest,
    private readonly current: () => boolean,
    private readonly gate: (enabled: boolean) => void,
    private readonly fail: (error: Error) => void,
  ) {}

  private alive(): boolean {
    return !this.stopped && !this.lane.isStopped && this.current();
  }

  private async write(data: string): Promise<void> {
    for (let offset = 0; offset < data.length && this.alive(); ) {
      let end = Math.min(offset + 8192, data.length);
      const last = data.charCodeAt(end - 1);
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
      this.lane.write(this.terminal, data.slice(offset, end));
      await this.lane.whenIdle();
      offset = end;
    }
  }

  /** Refusal happens before resetting/resizing the existing renderer. No process mutation. */
  async start(snapshot: TerminalSessionSnapshot): Promise<void> {
    if (!snapshot.runtimeGeneration)
      throw new TerminalHistoryUnavailableError("missing-generation");
    this.identity = {
      threadId: snapshot.threadId,
      terminalId: snapshot.terminalId,
      expectedGeneration: snapshot.runtimeGeneration,
    };
    await this.restore();
    if (this.alive()) this.schedule();
  }

  private async restore(): Promise<void> {
    const result = await withTerminalViewDeadline(this.request(this.identity!));
    if (!this.alive()) return;
    if (result.type !== "snapshot")
      throw new TerminalHistoryUnavailableError(
        result.type === "unavailable" ? result.reason : "snapshot-required",
      );
    const frame = result.frame;
    if (frame.generation !== this.identity!.expectedGeneration)
      throw new TerminalHistoryUnavailableError("generation-mismatch");
    await this.lane.whenIdle();
    if (!this.alive()) return;
    this.gate(false); // Historical queries and input stay suppressed through the final parser tail.
    this.releaseGeometry ??= ownRecoveryGeometry(this.terminal);
    await this.write("\x1bc");
    if (!this.alive()) return;
    this.terminal.resize(frame.cols, frame.rows);
    await this.write(frame.ansi);
    await this.write(frame.pendingEscapeTail);
    if (!this.alive()) return;
    this.cursor = { generation: frame.generation, sequence: frame.sequence };
    this.gate(true);
  }

  /** Legacy output/activity is only a wake hint, never recovery data or sequence authority. */
  notify(): void {
    this.notified = true;
    if (!this.cursor || this.polling || this.stopped || this.idleDelay === 50) return;
    clearTimeout(this.timer);
    this.idleDelay = 50;
    this.schedule();
  }

  private schedule(): void {
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    const delay = hidden ? Math.max(1000, this.idleDelay) : this.idleDelay;
    this.timer = setTimeout(() => {
      this.polling = true;
      this.notified = false;
      void this.poll()
        .catch((error: unknown) => {
          if (this.alive()) {
            this.dispose();
            this.fail(error instanceof Error ? error : new Error("Terminal recovery failed"));
          }
        })
        .finally(() => {
          this.polling = false;
        });
    }, delay);
  }

  private async poll(): Promise<void> {
    if (!this.alive()) return;
    const result = await withTerminalViewDeadline(
      this.request({ ...this.identity!, after: this.cursor! }),
    );
    if (!this.alive()) return;
    if (result.type === "snapshot-required") {
      this.idleDelay = 50;
      this.gate(false);
      if (++this.resets > 3) throw new TerminalHistoryUnavailableError("recovery-cannot-keep-up");
      await this.restore();
    } else {
      if (result.type !== "suffix")
        throw new TerminalHistoryUnavailableError(
          result.type === "unavailable" ? result.reason : "invalid-suffix",
        );
      let sequence = this.cursor!.sequence;
      let bytes = 0;
      for (const record of result.records) {
        if (record.generation !== this.cursor!.generation || record.sequence !== ++sequence)
          throw new TerminalHistoryUnavailableError("noncontiguous-suffix");
        bytes += 64 + (record.type === "output" ? record.data.length * 2 : 0);
      }
      if (
        bytes > 2 * 1024 * 1024 ||
        result.through.generation !== this.cursor!.generation ||
        result.through.sequence !== sequence
      )
        throw new TerminalHistoryUnavailableError("invalid-suffix-cut");
      for (const record of result.records) {
        if (!this.alive()) return;
        if (record.type === "output") await this.write(record.data);
        else {
          await this.lane.whenIdle();
          if (this.alive()) this.terminal.resize(record.cols, record.rows);
        }
      }
      this.cursor = result.through;
      this.idleDelay =
        result.records.length || this.notified ? 50 : Math.min(2000, this.idleDelay * 2);
      if (result.records.length) this.resets = 0;
    }
    if (this.alive()) this.schedule();
  }

  dispose(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.releaseGeometry?.();
  }
}
