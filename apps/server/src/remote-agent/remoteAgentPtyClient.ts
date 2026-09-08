import { randomUUID } from "node:crypto";

import { RemoteAgentConnection, RemoteAgentConnectionError } from "./remoteAgentConnection.ts";
import type { RemoteAgentPtyCreateResponse, RemoteAgentPtyExited } from "./remoteAgentProtocol.ts";

export interface RemoteAgentPtyProcessLike {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): () => void;
  onExit(callback: (event: { exitCode: number; signal: number | null }) => void): () => void;
  onError?(callback: (error: Error) => void): () => void;
}

export class RemoteAgentPtyError extends Error {
  readonly _tag = "RemoteAgentPtyError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RemoteAgentPtyError";
  }
}

type Reconnect = (() => Promise<RemoteAgentConnection>) | undefined;

export class RemoteAgentPtyProcess implements RemoteAgentPtyProcessLike {
  private currentConnection: RemoteAgentConnection;
  private removeFrameListener: (() => void) | undefined;
  private removeFailureListener: (() => void) | undefined;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<
    RemoteAgentPtyProcessLike["onExit"] extends (callback: infer Callback) => infer _
      ? Callback
      : never
  >();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly decoder = new TextDecoder();
  private nextInputSequence = 1;
  private lastOutputSequence = 0;
  private didExit = false;
  private reconnecting: Promise<void> | undefined;
  private reconnectAttempts = 0;
  private closing = false;

  constructor(
    connection: RemoteAgentConnection,
    readonly ptyId: string,
    private readonly reconnect: Reconnect,
    private _pid = 0,
  ) {
    this.currentConnection = connection;
    this.listen(connection);
  }

  get pid(): number {
    return this._pid;
  }

  setPid(pid: number): void {
    this._pid = pid;
  }

  write(data: string): void {
    if (this.didExit || this.closing) return;
    const sequence = this.nextInputSequence;
    this.nextInputSequence += 1;
    void this.sendInput(sequence, new TextEncoder().encode(data));
  }

  resize(cols: number, rows: number): void {
    if (this.didExit || this.closing) return;
    void this.sendRequest(
      {
        type: "ptyResizeRequest",
        value: { requestId: randomUUID(), ptyId: this.ptyId, cols, rows },
      },
      (frame) => frame.type === "ptyResizeResponse" && frame.value.ptyId === this.ptyId,
    );
  }

  kill(signal = "SIGTERM"): void {
    if (this.didExit) return;
    if (signal === "SIGKILL") {
      void this.sendSignal(signal);
      return;
    }
    void this.sendSignal(signal);
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

  async attach(afterSequence = this.lastOutputSequence): Promise<void> {
    const response = await this.currentConnection.request(
      {
        type: "ptyAttachRequest",
        value: { requestId: randomUUID(), ptyId: this.ptyId, afterSequence },
      },
      (frame) => frame.type === "ptyAttachResponse" && frame.value.ptyId === this.ptyId,
    );
    if (response.type === "ptyAttachResponse" && response.value.replayGap) {
      this.report(
        new RemoteAgentPtyError(
          "PTY_REPLAY_GAP",
          `PTY output replay begins at sequence ${response.value.firstRetainedSequence}.`,
        ),
      );
    }
  }

  async close(terminate = true): Promise<void> {
    if (this.didExit) return;
    this.closing = true;
    try {
      await this.currentConnection.request(
        {
          type: "ptyCloseRequest",
          value: { requestId: randomUUID(), ptyId: this.ptyId, terminate },
        },
        (frame) => frame.type === "ptyCloseResponse" && frame.value.ptyId === this.ptyId,
      );
    } finally {
      this.finish({ exitCode: 0, signal: null });
    }
  }

  private listen(connection: RemoteAgentConnection): void {
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
      } else if (frame.type === "ptyAttachResponse" && frame.value.ptyId === this.ptyId) {
        if (frame.value.replayGap) {
          this.report(
            new RemoteAgentPtyError(
              "PTY_REPLAY_GAP",
              `PTY output replay begins at sequence ${frame.value.firstRetainedSequence}.`,
            ),
          );
        }
      }
      return false;
    });
  }

  private handleOutput(sequence: number, bytes: Uint8Array): void {
    if (sequence <= this.lastOutputSequence) return;
    if (sequence !== this.lastOutputSequence + 1) {
      this.report(
        new RemoteAgentPtyError(
          "PTY_OUTPUT_GAP",
          `Expected PTY output sequence ${this.lastOutputSequence + 1}, received ${sequence}.`,
        ),
      );
      return;
    }
    this.lastOutputSequence = sequence;
    const text = this.decoder.decode(bytes, { stream: true });
    if (text.length > 0) {
      for (const listener of this.dataListeners) listener(text);
    }
    void this.currentConnection
      .request(
        {
          type: "ptyOutputAck",
          value: {
            requestId: `${this.ptyId}:ack:${sequence}`,
            ptyId: this.ptyId,
            acknowledgedSequence: sequence,
          },
        },
        (frame) => frame.type === "ptyOutputAckResponse" && frame.value.ptyId === this.ptyId,
      )
      .catch((cause: unknown) => this.recover(cause));
  }

  private handleExit(value: RemoteAgentPtyExited): void {
    this.finish({
      exitCode: value.hasExitCode ? value.exitCode : 0,
      signal: value.hasSignal ? value.signal : null,
    });
  }

  private async sendInput(sequence: number, bytes: Uint8Array): Promise<void> {
    try {
      await this.sendRequest(
        {
          type: "ptyInput",
          value: {
            requestId: `${this.ptyId}:input:${sequence}`,
            ptyId: this.ptyId,
            sequence,
            bytes,
          },
        },
        (frame) => frame.type === "ptyInputResponse" && frame.value.ptyId === this.ptyId,
      );
    } catch (cause) {
      if (await this.recover(cause)) {
        if (!this.didExit && !this.closing) await this.sendInput(sequence, bytes);
      }
    }
  }

  private async sendSignal(signal: string): Promise<void> {
    try {
      await this.sendRequest(
        {
          type: "ptySignalRequest",
          value: { requestId: randomUUID(), ptyId: this.ptyId, signal },
        },
        (frame) => frame.type === "ptySignalResponse" && frame.value.ptyId === this.ptyId,
      );
    } catch (cause) {
      await this.recover(cause);
    }
  }

  private async sendRequest(
    frame: Parameters<RemoteAgentConnection["request"]>[0],
    matches: (frame: Awaited<ReturnType<RemoteAgentConnection["nextFrame"]>>) => boolean,
  ): Promise<void> {
    const response = await this.currentConnection.request(frame, matches);
    const value = response.value as {
      readonly accepted?: boolean;
      readonly errorCode?: string;
      readonly errorMessage?: string;
    };
    if (value.accepted === false) {
      throw new RemoteAgentPtyError(
        value.errorCode ?? "PTY_REQUEST_REJECTED",
        value.errorMessage || "Remote PTY request was rejected.",
      );
    }
  }

  private async recover(cause: unknown): Promise<boolean> {
    if (!this.reconnect || this.didExit || this.closing) {
      this.report(cause instanceof Error ? cause : new RemoteAgentConnectionError(String(cause)));
      return false;
    }
    if (this.reconnectAttempts >= 3) {
      this.report(
        new RemoteAgentPtyError(
          "PTY_RECONNECT_EXHAUSTED",
          "Remote PTY reconnect attempts exhausted.",
        ),
      );
      return false;
    }
    if (!this.reconnecting) {
      this.reconnectAttempts += 1;
      this.reconnecting = this.reconnect()
        .then((replacement) => {
          this.listen(replacement);
          return this.attach();
        })
        .finally(() => {
          this.reconnecting = undefined;
        });
    }
    try {
      await this.reconnecting;
      this.reconnectAttempts = 0;
      return true;
    } catch (error) {
      this.report(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  private report(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }

  private finish(event: { exitCode: number; signal: number | null }): void {
    if (this.didExit) return;
    this.didExit = true;
    this.removeFrameListener?.();
    this.removeFailureListener?.();
    this.removeFrameListener = undefined;
    this.removeFailureListener = undefined;
    const remainder = this.decoder.decode();
    if (remainder.length > 0) {
      for (const listener of this.dataListeners) listener(remainder);
    }
    for (const listener of this.exitListeners) listener(event);
  }
}

export class RemoteAgentPtyClient {
  constructor(
    readonly connection: RemoteAgentConnection,
    private readonly reconnect?: Reconnect,
  ) {}

  async create(input: {
    readonly ptyId?: string;
    readonly requestDigest?: Uint8Array;
    readonly workspaceHandle: string;
    readonly cwd: string;
    readonly shell: string;
    readonly args?: ReadonlyArray<string>;
    readonly cols: number;
    readonly rows: number;
    readonly environment?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  }): Promise<RemoteAgentPtyProcess> {
    const ptyId = input.ptyId ?? randomUUID();
    const process = new RemoteAgentPtyProcess(this.connection, ptyId, this.reconnect);
    try {
      const response = (await this.connection.request(
        {
          type: "ptyCreateRequest",
          value: {
            requestId: randomUUID(),
            ptyId,
            requestDigest: input.requestDigest ?? new Uint8Array(),
            workspaceHandle: input.workspaceHandle,
            cwd: input.cwd,
            shell: input.shell,
            args: input.args ?? [],
            cols: input.cols,
            rows: input.rows,
            ...(input.environment ? { environment: input.environment } : {}),
          },
        },
        (frame) => frame.type === "ptyCreateResponse" && frame.value.ptyId === ptyId,
      )) as { readonly type: "ptyCreateResponse"; readonly value: RemoteAgentPtyCreateResponse };
      if (!response.value.accepted) {
        throw new RemoteAgentPtyError(response.value.errorCode, response.value.errorMessage);
      }
      process.setPid(response.value.pid);
      await process.attach(0);
      return process;
    } catch (cause) {
      await process.close(false).catch(() => undefined);
      throw cause;
    }
  }
}
