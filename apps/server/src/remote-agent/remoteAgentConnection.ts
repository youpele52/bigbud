import { randomUUID } from "node:crypto";
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";

import { buildSshCommandInvocation } from "../ssh/sshCommand.ts";
import { assertSshExecutionTargetReady } from "../ssh/sshVerification.ts";
import { decodeDelimitedFrame, encodeDelimitedFrame } from "./remoteAgentProtocol.codec.ts";
import {
  REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES,
  REMOTE_AGENT_PROTOCOL_MAJOR,
  REMOTE_AGENT_PROTOCOL_MINOR,
  RemoteAgentProtocolDecodeError,
  type RemoteAgentFrame,
  type RemoteAgentHello,
} from "./remoteAgentProtocol.ts";
import { buildRemoteAgentProxyCommand } from "./remoteAgentSupervisor.ts";

export { buildRemoteAgentProxyCommand } from "./remoteAgentSupervisor.ts";

export class RemoteAgentConnectionError extends Error {
  readonly _tag = "RemoteAgentConnectionError";

  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RemoteAgentConnectionError";
  }
}

export interface RemoteAgentLocalProcessInput {
  readonly binaryPath: string;
  readonly mode?: "stdio" | "proxy";
  readonly args?: ReadonlyArray<string>;
  readonly maxFrameBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
}

interface ClosableChildProcess {
  readonly pid?: number | undefined;
  readonly stdin: { end: () => void };
  readonly kill: (signal?: NodeJS.Signals) => boolean;
}

export function remoteAgentLocalProcessArgs(
  input: Pick<RemoteAgentLocalProcessInput, "args" | "mode">,
): ReadonlyArray<string> {
  return input.args ?? (input.mode === "proxy" ? ["--proxy"] : []);
}

export function closeRemoteAgentProcess(
  child: ClosableChildProcess,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly taskkill?: typeof spawnSync;
  } = {},
): void {
  child.stdin.end();
  if ((options.platform ?? process.platform) === "win32" && child.pid !== undefined) {
    try {
      const result = (options.taskkill ?? spawnSync)(
        "taskkill",
        ["/pid", String(child.pid), "/T", "/F"],
        { stdio: "ignore" },
      );
      if (result.status === 0) return;
    } catch {
      // taskkill unavailable — fall through to direct termination.
    }
  }
  child.kill("SIGTERM");
}

export interface RemoteAgentSshProcessInput {
  readonly executionTargetId: string;
  readonly binaryPath: string;
  readonly maxFrameBytes?: number;
}

type FrameWaiter = {
  readonly resolve: (frame: RemoteAgentFrame) => void;
  readonly reject: (error: Error) => void;
  readonly matches?: (frame: RemoteAgentFrame) => boolean;
};

type FrameListener = (frame: RemoteAgentFrame) => boolean | void;

function shellQuote(value: string): string {
  if (/^\$HOME(?:\/[\w.+-]+)*$/.test(value)) {
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildRemoteAgentIdentityProbeCommand(binaryPath: string): string {
  const binary = shellQuote(binaryPath);
  return `if test -x ${binary}; then exec ${binary} --check; else printf 'missing'; fi`;
}

export class RemoteAgentConnection {
  private readonly maxFrameBytes: number;
  private readonly child: ChildProcessWithoutNullStreams;
  private stderrTail = "";
  private readBuffer = Buffer.alloc(0);
  private readonly queuedFrames: RemoteAgentFrame[] = [];
  private readonly waiters: FrameWaiter[] = [];
  private readonly frameListeners = new Set<FrameListener>();
  private readonly failureListeners = new Set<(error: Error) => void>();
  private failure: Error | null = null;
  private closed = false;

  private constructor(child: ChildProcessWithoutNullStreams, maxFrameBytes: number) {
    this.child = child;
    this.maxFrameBytes = maxFrameBytes;
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stdout.on("error", (error) => this.fail(error));
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-4_096);
    });
    child.on("error", (error) => this.fail(error));
    child.on("close", (code, signal) => {
      if (!this.closed && !this.failure) {
        const detail = this.stderrTail.trim();
        this.fail(
          new RemoteAgentConnectionError(
            `Remote agent exited before the request completed (code=${code ?? "null"}, signal=${signal ?? "null"})${detail ? `: ${detail}` : "."}`,
          ),
        );
      }
    });
  }

  static local(input: RemoteAgentLocalProcessInput): RemoteAgentConnection {
    const maxFrameBytes = input.maxFrameBytes ?? REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES;
    return new RemoteAgentConnection(
      spawn(input.binaryPath, remoteAgentLocalProcessArgs(input), {
        stdio: ["pipe", "pipe", "pipe"],
        ...(input.env ? { env: input.env } : {}),
      }),
      maxFrameBytes,
    );
  }

  get processId(): number | undefined {
    return this.child.pid;
  }

  static ssh(input: RemoteAgentSshProcessInput): RemoteAgentConnection {
    assertSshExecutionTargetReady(input.executionTargetId);
    const maxFrameBytes = input.maxFrameBytes ?? REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES;
    const invocation = buildSshCommandInvocation({
      executionTargetId: input.executionTargetId,
      command: "sh",
      args: ["-lc", buildRemoteAgentProxyCommand(input.binaryPath)],
    });
    return new RemoteAgentConnection(
      spawn(invocation.command, invocation.args, { stdio: ["pipe", "pipe", "pipe"] }),
      maxFrameBytes,
    );
  }

  async handshake(
    input: {
      readonly clientInstanceId?: string;
      readonly connectionId?: string;
      readonly serverNonce?: string;
    } = {},
  ): Promise<RemoteAgentHello> {
    await this.send({
      type: "clientHello",
      value: {
        protocolMajor: REMOTE_AGENT_PROTOCOL_MAJOR,
        protocolMinor: REMOTE_AGENT_PROTOCOL_MINOR,
        clientInstanceId: input.clientInstanceId ?? randomUUID(),
        connectionId: input.connectionId ?? randomUUID(),
        serverNonce: input.serverNonce ?? randomUUID(),
        maxFrameBytes: this.maxFrameBytes,
      },
    });
    const frame = await this.nextFrame();
    if (frame.type === "protocolError") {
      throw new RemoteAgentConnectionError(
        `${frame.value.code}: ${frame.value.message}`,
        frame.value.code,
      );
    }
    if (frame.type !== "agentHello") {
      throw new RemoteAgentConnectionError(`Expected agent hello, received ${frame.type}.`);
    }
    if (frame.value.protocolMajor !== REMOTE_AGENT_PROTOCOL_MAJOR) {
      throw new RemoteAgentConnectionError(
        `Remote agent protocol major ${frame.value.protocolMajor} is incompatible with ${REMOTE_AGENT_PROTOCOL_MAJOR}.`,
        "UNSUPPORTED_PROTOCOL_MAJOR",
      );
    }
    return frame.value;
  }

  async send(frame: RemoteAgentFrame): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.closed) throw new RemoteAgentConnectionError("Remote agent connection is closed.");
    const encoded = encodeDelimitedFrame(frame, this.maxFrameBytes);
    await new Promise<void>((resolve, reject) => {
      const writable = this.child.stdin.write(Buffer.from(encoded), (error) => {
        if (error) reject(error);
        else resolve();
      });
      if (!writable) this.child.stdin.once("drain", resolve);
    });
  }

  async nextFrame(matches?: (frame: RemoteAgentFrame) => boolean): Promise<RemoteAgentFrame> {
    const queuedIndex = matches
      ? this.queuedFrames.findIndex((frame) => frame.type === "protocolError" || matches(frame))
      : this.queuedFrames.findIndex(
          (frame) =>
            !this.waiters.some(
              (waiter) =>
                waiter.matches && (frame.type === "protocolError" || waiter.matches(frame)),
            ),
        );
    if (queuedIndex >= 0) return this.queuedFrames.splice(queuedIndex, 1)[0]!;
    if (this.failure) throw this.failure;
    if (this.closed) throw new RemoteAgentConnectionError("Remote agent connection is closed.");
    return new Promise<RemoteAgentFrame>((resolve, reject) => {
      this.waiters.push(matches ? { resolve, reject, matches } : { resolve, reject });
    });
  }

  async request(
    frame: RemoteAgentFrame,
    matches: (response: RemoteAgentFrame) => boolean,
  ): Promise<RemoteAgentFrame> {
    const queued = this.takeQueuedFrame(matches);
    if (queued) return this.assertRequestResponse(queued);
    const response = await new Promise<RemoteAgentFrame>((resolve, reject) => {
      const waiter: FrameWaiter = {
        resolve,
        reject,
        matches,
      };
      this.waiters.push(waiter);
      void this.send(frame).catch((error: unknown) => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(error instanceof Error ? error : new RemoteAgentConnectionError(String(error)));
      });
    });
    return this.assertRequestResponse(response);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeRemoteAgentProcess(this.child);
    const error = new RemoteAgentConnectionError("Remote agent connection is closed.");
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    if (this.failure) listener(this.failure);
    return () => this.failureListeners.delete(listener);
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  private consume(chunk: Buffer): void {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
    while (this.readBuffer.length >= 4) {
      const length = this.readBuffer.readUInt32BE(0);
      if (length > this.maxFrameBytes) {
        this.fail(new RemoteAgentProtocolDecodeError("frame exceeds configured maximum"));
        return;
      }
      if (this.readBuffer.length < length + 4) return;
      const encoded = this.readBuffer.subarray(0, length + 4);
      this.readBuffer = this.readBuffer.subarray(length + 4);
      try {
        this.deliver(decodeDelimitedFrame(encoded, this.maxFrameBytes));
      } catch (error) {
        this.fail(error);
        return;
      }
    }
  }

  private deliver(frame: RemoteAgentFrame): void {
    let consumed = false;
    for (const listener of this.frameListeners) {
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
    if (waiter) waiter.resolve(frame);
    else if (!consumed) this.queuedFrames.push(frame);
  }

  private takeQueuedFrame(
    matches: (frame: RemoteAgentFrame) => boolean,
  ): RemoteAgentFrame | undefined {
    const index = this.queuedFrames.findIndex(
      (frame) => frame.type === "protocolError" || matches(frame),
    );
    return index >= 0 ? this.queuedFrames.splice(index, 1)[0] : undefined;
  }

  private assertRequestResponse(frame: RemoteAgentFrame): RemoteAgentFrame {
    if (frame.type === "protocolError") {
      throw new RemoteAgentConnectionError(
        `${frame.value.code}: ${frame.value.message}`,
        frame.value.code,
      );
    }
    return frame;
  }

  private fail(error: unknown): void {
    if (this.failure || this.closed) return;
    this.failure = error instanceof Error ? error : new RemoteAgentConnectionError(String(error));
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.failure);
    for (const listener of this.failureListeners) listener(this.failure);
  }
}
