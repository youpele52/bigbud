import {
  reconnectRemotePty,
  remotePtyReconnectFailure,
  remotePtyInterruptedError,
} from "./remoteAgentPtyClient.reconnect";
import { createRemotePtyResizeControl } from "./remoteAgentPtyClient.controls";
import { confirmRemotePtyAttachment } from "./remoteAgentPtyClient.confirm.ts";
import { attachRemotePty } from "./remoteAgentPtyClient.attach";
import { RemoteAgentPtyOutput } from "./remoteAgentPtyClient.output";
import { RemoteAgentPtyInput } from "./remoteAgentPtyClient.input.ts";
import { detachRemotePty } from "./remoteAgentPtyClient.detach";
import { sendRemotePtyRequest, signalRemotePty } from "./remoteAgentPtyClient.request";
import { randomUUID } from "node:crypto";
import { type RemoteAgentReconnectEpisodeResult } from "./remoteAgentReconnectPolicy.ts";

/** Test seam for reconnect delays; production uses the contract's real timers. */
export const remoteAgentPtyReconnectTiming: { delay?: (ms: number) => Promise<void> } = {};

import { RemoteAgentConnection, RemoteAgentConnectionError } from "./remoteAgentConnection.ts";
import type { RemoteAgentPtyExited } from "./remoteAgentProtocol.ts";
import { remoteAgentPtyTerminalEvidence } from "./remoteAgentTerminalEvidence.ts";
export { RemoteAgentPtyClient } from "./remoteAgentPtyClient.create.ts";

import {
  RemoteAgentPtyError,
  type RemoteAgentPtyProcessLike,
  type RemoteAgentPtyDurability,
  type RemoteAgentPtyExitListener,
} from "./remoteAgentPtyClient.types.ts";
export {
  RemoteAgentPtyError,
  type RemoteAgentPtyProcessLike,
} from "./remoteAgentPtyClient.types.ts";

type Reconnect = (() => Promise<RemoteAgentConnection>) | undefined;

export class RemoteAgentPtyProcess implements RemoteAgentPtyProcessLike {
  private currentConnection: RemoteAgentConnection;
  private attachmentRevision = 0;
  private removeFrameListener: (() => void) | undefined;
  private removeFailureListener: (() => void) | undefined;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<RemoteAgentPtyExitListener>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly output: RemoteAgentPtyOutput;
  private readonly resizeControl: ReturnType<typeof createRemotePtyResizeControl>;
  private readonly input: RemoteAgentPtyInput;

  private didExit = false;
  private _launchStatus: "unconfirmed" | undefined;
  private reconnecting: Promise<RemoteAgentReconnectEpisodeResult<void>> | undefined;
  private closing = false;
  private recoveryNeeded = false;
  private readonly controlRequests = new AbortController();
  private _interruptionReason: "remote-service-restarted" | undefined;
  private durability: RemoteAgentPtyDurability | undefined;

  constructor(
    connection: RemoteAgentConnection,
    readonly ptyId: string,
    private readonly reconnect: Reconnect,
    private _pid = 0,
  ) {
    this.currentConnection = connection;
    this.input = new RemoteAgentPtyInput({
      ptyId,
      available: () =>
        !this.didExit &&
        !this.closing &&
        !this.controlRequests.signal.aborted &&
        !this.recoveryNeeded &&
        !this.reconnecting,
      durability: () => this.durability,
      request: (frame, matches) => this.sendRequest(frame, matches),
      recover: (cause) => (this.reconnect ? this.recover(cause) : Promise.resolve(false)),
      report: (error) => this.report(error),
      reconcile: (signal) =>
        this.durability?.reconcile?.(
          this.currentConnection,
          signal
            ? AbortSignal.any([signal, this.controlRequests.signal])
            : this.controlRequests.signal,
        ),
    });
    this.output = new RemoteAgentPtyOutput(
      ptyId,
      () => this.currentConnection,
      (sequence) => this.durability?.output(sequence),
      (cause) => {
        void this.recover(cause);
      },
    );
    this.resizeControl = createRemotePtyResizeControl(
      ptyId,
      () => this.currentConnection,
      (cause) => {
        void this.recover(cause);
      },
    );
    this.listen(connection);
  }
  get pid(): number {
    return this._pid;
  }
  get interruptionReason(): "remote-service-restarted" | undefined {
    return this._interruptionReason;
  }
  interrupt(reason: "remote-service-restarted"): void {
    if (this.didExit) return;
    this._interruptionReason = reason;
    this.report(remotePtyInterruptedError());
    this.finish({ exitCode: 1, signal: null });
  }
  setPid(pid: number): void {
    this._pid = pid;
  }
  get launchStatus(): "unconfirmed" | undefined {
    return this._launchStatus;
  }
  setLaunchStatus(status: "unconfirmed" | undefined): void {
    // Omitted legacy evidence remains unknown; never infer confirmation from PID/state.
    this._launchStatus = status;
  }
  detach(): void {
    this.closing = true;
    this.controlRequests.abort();
    this.output.stop();
    this.resizeControl.stop();
    this.removeFrameListener?.();
    this.removeFailureListener?.();
  }
  async detachRemote(): Promise<void> {
    if (this.reconnecting || this.input.pending)
      throw new RemoteAgentPtyError(
        "PTY_BUSY",
        "Wait for terminal recovery or input to settle before detaching.",
      );
    this.closing = true;
    try {
      await detachRemotePty(this.currentConnection, this.ptyId);
      this.detach();
    } catch (cause) {
      // Unsubscribe may have succeeded; reopening must reconcile the same remote identity.
      this.recoveryNeeded = true;
      this.closing = false;
      throw cause;
    }
  }

  retireControlRequests(): void {
    this.controlRequests.abort();
  }

  setDurability(durability: NonNullable<RemoteAgentPtyProcess["durability"]>): void {
    this.durability = durability;
  }

  async reconcileInput(signal?: AbortSignal): Promise<void> {
    await this.input.reconcile(signal);
  }

  restoreSequences(output: number, nextInput: number, acknowledgedInput: number): void {
    this.output.sequence = output;
    this.input.restore(nextInput, acknowledgedInput);
  }

  write(data: string): void {
    this.input.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.didExit || this.closing) return;
    this.resizeControl.push({ cols, rows });
  }

  kill(signal = "SIGTERM"): void {
    if (this.didExit) return;
    void this.sendSignal(signal).catch((cause: unknown) => this.recover(cause));
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }

  onExit(callback: (event: { exitCode: number; signal: number | null }) => void): () => void {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }

  onError(callback: (error: Error) => void): () => void {
    this.errorListeners.add(callback);
    return () => this.errorListeners.delete(callback);
  }

  async attach(
    afterSequence = this.output.sequence,
    signal = this.controlRequests.signal,
    expectedPid?: number,
    reconciliationSignal = signal,
  ): Promise<void> {
    await attachRemotePty(
      this.currentConnection,
      this.ptyId,
      afterSequence,
      (response) => {
        if (
          expectedPid !== undefined &&
          (response.state !== "running" || response.pid !== expectedPid)
        )
          throw new RemoteAgentPtyError(
            "PTY_ATTACH_UNCONFIRMED",
            "Remote terminal is not confirmed running with its original process identity.",
          );
        this._pid = response.pid;
        this.setLaunchStatus(response.launchStatus);
      },
      (sequence) => {
        this.output.sequence = Math.max(this.output.sequence, sequence);
      },
      (error) => this.report(error),
      signal,
    );
    await this.input.reconcile(reconciliationSignal);
  }

  async close(terminate = true): Promise<void> {
    if (this.didExit) return;
    this.closing = true;
    try {
      await this.sendRequest(
        {
          type: "ptyCloseRequest",
          value: { requestId: randomUUID(), ptyId: this.ptyId, terminate },
        },
        (frame) => frame.type === "ptyCloseResponse" && frame.value.ptyId === this.ptyId,
      );
    } catch (cause) {
      this.closing = false;
      throw cause;
    }
  }

  private listen(connection: RemoteAgentConnection): void {
    this.attachmentRevision++;
    this.removeFrameListener?.();
    this.removeFailureListener?.();
    this.currentConnection = connection;
    this.removeFailureListener = connection.onFailure((error) => {
      void this.recover(error);
    });
    this.removeFrameListener = connection.onFrame((frame) => {
      if (frame.type === "ptyOutput" && frame.value.ptyId === this.ptyId) {
        this.handleOutput(frame.value.sequence, frame.value.bytes);
        return true;
      } else if (frame.type === "ptyExited" && frame.value.ptyId === this.ptyId) {
        this.handleExit(frame.value);
        return true;
      }
      return false;
    });
  }

  private handleOutput(sequence: number, bytes: Uint8Array): void {
    if (sequence <= this.output.sequence) return;
    if (sequence !== this.output.sequence + 1) {
      this.report(
        new RemoteAgentPtyError(
          "PTY_OUTPUT_GAP",
          `Expected PTY output sequence ${this.output.sequence + 1}, received ${sequence}.`,
        ),
      );
      return;
    }
    this.output.sequence = sequence;
    const text = this.output.decode(bytes);
    if (text.length > 0) {
      for (const listener of this.dataListeners) listener(text);
    }
    this.output.acknowledge(sequence);
  }

  private handleExit(value: RemoteAgentPtyExited): void {
    if (remoteAgentPtyTerminalEvidence(value) !== "verified-terminal") {
      this.report(
        new RemoteAgentPtyError(
          "PTY_OUTCOME_UNKNOWN",
          "PTY control ended without a verified child exit. Recovery ownership was retained.",
        ),
      );
      return;
    }
    this.finish({
      exitCode: value.hasExitCode ? value.exitCode : 0,
      signal: value.hasSignal ? value.signal : null,
    });
  }

  /** Exact remote PTY identity; request acknowledgement alone never proves exit. */
  async sendSignal(signal: string): Promise<void> {
    if (this.didExit) return;
    await signalRemotePty(this.currentConnection, this.ptyId, signal, this.controlRequests.signal);
  }

  private async sendRequest(
    frame: Parameters<RemoteAgentConnection["request"]>[0],
    matches: (frame: Awaited<ReturnType<RemoteAgentConnection["nextFrame"]>>) => boolean,
  ): Promise<void> {
    await sendRemotePtyRequest(this.currentConnection, frame, matches, this.controlRequests.signal);
  }

  private async recover(cause: unknown): Promise<boolean> {
    const reconnect = this.reconnect;
    this.recoveryNeeded = true;
    if (!reconnect || this.didExit || this.closing) {
      this.report(cause instanceof Error ? cause : new RemoteAgentConnectionError(String(cause)));
      return false;
    }
    // One bounded, jittered episode per failure burst; concurrent failures join it.
    this.reconnecting ??= reconnectRemotePty({
      connect: reconnect,
      attach: async (replacement, signal) => {
        this.listen(replacement);
        await this.attach(undefined, signal, this._pid > 0 ? this._pid : undefined);
      },
      cancelled: () => this.didExit || this.closing,
      signal: this.controlRequests.signal,
      ...(remoteAgentPtyReconnectTiming.delay
        ? { delay: remoteAgentPtyReconnectTiming.delay }
        : {}),
    }).finally(() => {
      this.reconnecting = undefined;
    });
    const result = await this.reconnecting;
    if (result.status === "connected") {
      this.recoveryNeeded = false;
      return true;
    }
    if (result.status === "cancelled") return false;
    this.report(remotePtyReconnectFailure(result));
    return false;
  }

  async retryRecovery(): Promise<void> {
    if (this.recoveryNeeded && !(await this.recover(new Error("Manual terminal reconnect"))))
      throw new RemoteAgentPtyError(
        "PTY_UNAVAILABLE",
        "Terminal recovery is unconfirmed; no shell was restarted.",
      );
    await this.input.retryRecovery();
  }
  /** Opening a warm pane needs an agent receipt, not cached transport flags. */
  confirmAttachment(parentSignal?: AbortSignal): Promise<void> {
    return confirmRemotePtyAttachment(
      {
        signal: this.controlRequests.signal,
        state: () => ({
          pid: this._pid,
          revision: this.attachmentRevision,
          active: !this.didExit && !this.closing,
          recovering: this.recoveryNeeded || !!this.reconnecting,
        }),
        retry: () => this.retryRecovery(),
        attach: (pid, signal) => this.attach(undefined, signal, pid, this.controlRequests.signal),
        assertInputUsable: () => this.input.assertUsable(),
        failed: (revision, error) => {
          if (
            revision !== this.attachmentRevision ||
            this.reconnecting ||
            this.didExit ||
            this.closing
          )
            return;
          this.recoveryNeeded = true;
          this.report(error);
        },
      },
      parentSignal,
    );
  }
  private report(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
  private finish(event: { exitCode: number; signal: number | null }): void {
    if (this.didExit) return;
    this.didExit = true;
    this.resizeControl.stop();
    this.removeFrameListener?.();
    this.removeFailureListener?.();
    this.removeFrameListener = undefined;
    this.removeFailureListener = undefined;
    const remainder = this.output.finish();
    if (remainder.length > 0) {
      for (const listener of this.dataListeners) listener(remainder);
    }
    for (const listener of this.exitListeners) listener(event);
  }
}
