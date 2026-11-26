import {
  trackRemoteAgentProcess,
  closeAndConfirmRemoteAgentProcess,
  finishRemoteAgentGracefulClose,
} from "./remoteAgentConnection.process.ts";
import { requestRemoteFrame, type FrameWaiter } from "./remoteAgentConnection.request";
import {
  openOwnedRemoteAgentProxy,
  REMOTE_AGENT_PROXY_CLOSE_TIMEOUT_MS,
  trackOwnedRemoteAgentProxy,
  type RemoteAgentOwnedSshInput,
  type RemoteAgentProxyLease,
  type RemoteAgentProxyPipes,
} from "./remoteAgentConnection.owner.ts";
import { RemoteAgentFrameInbox, type FrameListener } from "./remoteAgentConnection.inbox.ts";
import { randomUUID } from "node:crypto";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { type KillProcessTreeOptions, killProcessTree } from "../utils/killProcessTree.ts";

import { buildSshCommandInvocation } from "../ssh/sshCommand.ts";
import { assertSshExecutionTargetReadyAsync } from "../ssh/sshVerification.ts";
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
import { buildPinnedRemoteAgentProxy } from "./remoteAgentRuntime.launch.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";

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
  options: KillProcessTreeOptions = {},
): void {
  child.stdin.end();
  killProcessTree(child, "SIGTERM", options);
}

export interface RemoteAgentSshProcessInput {
  readonly runtime?: RemoteAgentRuntime;
  readonly executionTargetId: string;
  readonly binaryPath: string;
  readonly maxFrameBytes?: number;
  readonly signal?: never;
  readonly timeoutMs?: never;
}

type RemoteAgentConnectionTransport =
  | { readonly ownerLease: RemoteAgentProxyLease }
  | ChildProcessWithoutNullStreams;

export { buildRemoteAgentIdentityProbeCommand } from "./remoteAgentConnection.identity.ts";

export class RemoteAgentConnection {
  private readonly maxFrameBytes: number;
  private readonly stdin: RemoteAgentProxyPipes["stdin"];
  private readonly lifecycle:
    | ReturnType<typeof trackOwnedRemoteAgentProxy>
    | {
        child: ChildProcessWithoutNullStreams;
        process: ReturnType<typeof trackRemoteAgentProcess>;
      };
  private stderrTail = "";
  private readBuffer = Buffer.alloc(0);
  private readonly inbox: RemoteAgentFrameInbox;
  private readonly failureListeners = new Set<(error: Error) => void>();
  private failure: Error | null = null;
  private closed = false;
  private negotiatedCapabilities: RemoteAgentHello["capabilities"] = [];

  supportsCapability(name: string): boolean {
    return this.negotiatedCapabilities.some(
      (capability) => capability.name === name && capability.major === 1,
    );
  }

  private constructor(
    transport: RemoteAgentConnectionTransport,
    maxFrameBytes: number,
    maxUnclaimedFrames?: number,
  ) {
    this.inbox = new RemoteAgentFrameInbox(maxUnclaimedFrames);
    this.maxFrameBytes = maxFrameBytes;
    const pipes = "ownerLease" in transport ? transport.ownerLease.pipes : transport;
    this.stdin = pipes.stdin;
    pipes.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    // A proxy can exit while a cleanup request is still writing.
    for (const pipe of [pipes.stdin, pipes.stdout]) pipe.on("error", (error) => this.fail(error));
    pipes.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-4_096);
    });
    const onExit = (code: number | null, signal: string | null) => {
      if (this.closed || this.failure) return;
      const detail = this.stderrTail.trim();
      this.fail(
        new RemoteAgentConnectionError(
          `Remote agent exited before the request completed (code=${code ?? "null"}, signal=${signal ?? "null"})${detail ? `: ${detail}` : "."}`,
        ),
      );
    };
    if ("ownerLease" in transport) {
      this.lifecycle = trackOwnedRemoteAgentProxy(transport.ownerLease);
      pipes.stderr.on("error", (error) => this.fail(error));
      void transport.ownerLease.exit.then(
        ({ code, signal }) => onExit(code, signal),
        (error) => this.fail(error),
      );
    } else {
      this.lifecycle = { child: transport, process: trackRemoteAgentProcess(transport) };
      transport.on("error", (error) => this.fail(error));
      transport.on("close", onExit);
    }
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
    return typeof this.lifecycle === "function" ? undefined : this.lifecycle.child.pid;
  }

  static async ssh(
    input: RemoteAgentSshProcessInput | RemoteAgentOwnedSshInput,
  ): Promise<RemoteAgentConnection> {
    const maxFrameBytes = input.maxFrameBytes ?? REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES;
    if ("owner" in input) {
      return openOwnedRemoteAgentProxy(
        input,
        (ownerLease) => new RemoteAgentConnection({ ownerLease }, maxFrameBytes),
      );
    }
    await assertSshExecutionTargetReadyAsync(input.executionTargetId);
    const proxyCommand = input.runtime
      ? buildPinnedRemoteAgentProxy(input.runtime)
      : buildRemoteAgentProxyCommand(input.binaryPath);
    const invocation = buildSshCommandInvocation({
      executionTargetId: input.executionTargetId,
      command: "sh",
      args: ["-lc", proxyCommand],
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
    const frame = this.assertRequestResponse(await this.nextFrame());
    if (frame.type !== "agentHello") {
      throw new RemoteAgentConnectionError(`Expected agent hello, received ${frame.type}.`);
    }
    if (frame.value.protocolMajor !== REMOTE_AGENT_PROTOCOL_MAJOR) {
      throw new RemoteAgentConnectionError(
        `Remote agent protocol major ${frame.value.protocolMajor} is incompatible with ${REMOTE_AGENT_PROTOCOL_MAJOR}.`,
        "UNSUPPORTED_PROTOCOL_MAJOR",
      );
    }
    this.negotiatedCapabilities = frame.value.capabilities;
    return frame.value;
  }

  async send(frame: RemoteAgentFrame): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.closed) throw new RemoteAgentConnectionError("Remote agent connection is closed.");
    const encoded = encodeDelimitedFrame(frame, this.maxFrameBytes);
    await this.sendEncoded(encoded);
  }

  async sendEncoded(encoded: Uint8Array): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.closed) throw new RemoteAgentConnectionError("Remote agent connection is closed.");
    if (encoded.byteLength < 4) {
      throw new RemoteAgentConnectionError("Encoded remote agent frame is truncated.");
    }
    const length = Buffer.from(encoded.buffer, encoded.byteOffset, 4).readUInt32BE(0);
    if (length > this.maxFrameBytes || length + 4 !== encoded.byteLength) {
      throw new RemoteAgentConnectionError("Encoded remote agent frame has an invalid length.");
    }
    await new Promise<void>((resolve, reject) => {
      const writable = this.stdin.write(Buffer.from(encoded), (error) => {
        if (error) reject(error);
        else resolve();
      });
      if (!writable) this.stdin.once("drain", resolve);
    });
  }

  async nextFrame(matches?: (frame: RemoteAgentFrame) => boolean): Promise<RemoteAgentFrame> {
    const queued = matches ? this.inbox.takeUnclaimed(matches) : this.inbox.takeUnwaited();
    if (queued) return queued;
    if (this.failure) throw this.failure;
    if (this.closed) throw new RemoteAgentConnectionError("Remote agent connection is closed.");
    return new Promise<RemoteAgentFrame>((resolve, reject) => {
      this.inbox.waiters.push(matches ? { resolve, reject, matches } : { resolve, reject });
    });
  }

  async request(
    frame: RemoteAgentFrame,
    matches: (response: RemoteAgentFrame) => boolean,
    signal?: AbortSignal,
  ): Promise<RemoteAgentFrame> {
    signal?.throwIfAborted();
    const queued = this.inbox.takeUnclaimed(matches);
    if (queued) return this.assertRequestResponse(queued);
    const response = await requestRemoteFrame(
      this.inbox.waiters,
      () => this.send(frame),
      matches,
      signal,
    );
    return this.assertRequestResponse(response);
  }

  async requestEncoded(
    encoded: Uint8Array,
    matches: (response: RemoteAgentFrame) => boolean,
  ): Promise<RemoteAgentFrame> {
    const queued = this.inbox.takeUnclaimed(matches);
    if (queued) return this.assertRequestResponse(queued);
    const response = await new Promise<RemoteAgentFrame>((resolve, reject) => {
      const waiter: FrameWaiter = { resolve, reject, matches };
      this.inbox.waiters.push(waiter);
      void this.sendEncoded(encoded).catch((error: unknown) => {
        const index = this.inbox.waiters.indexOf(waiter);
        if (index >= 0) this.inbox.waiters.splice(index, 1);
        reject(error instanceof Error ? error : new RemoteAgentConnectionError(String(error)));
      });
    });
    return this.assertRequestResponse(response);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (typeof this.lifecycle === "function") {
      void this.lifecycle("terminate", REMOTE_AGENT_PROXY_CLOSE_TIMEOUT_MS).catch(() => {});
    } else closeRemoteAgentProcess(this.lifecycle.child);
    this.rejectClosedWaiters();
  }

  /**
   * Ends the link as an ordinary transport loss: waiters and failure listeners see
   * `error` (keeping its code) before the child closes. `close()` alone notifies no listener.
   */
  disconnect(error: Error & { readonly code?: string }): void {
    this.fail(new RemoteAgentConnectionError(error.message, error.code));
    this.close();
  }

  async gracefulClose(timeoutMs = REMOTE_AGENT_PROXY_CLOSE_TIMEOUT_MS): Promise<void> {
    if (typeof this.lifecycle === "function") {
      const confirmed = this.lifecycle("graceful", timeoutMs);
      this.closed = true;
      return confirmed.finally(() => this.rejectClosedWaiters());
    }
    if (this.closed) return;
    this.closed = true;
    const { child } = this.lifecycle;
    await finishRemoteAgentGracefulClose(child, timeoutMs, () => closeRemoteAgentProcess(child));
    this.rejectClosedWaiters();
  }

  async closeConfirmed(timeoutMs = REMOTE_AGENT_PROXY_CLOSE_TIMEOUT_MS): Promise<void> {
    if (typeof this.lifecycle === "function") {
      const confirmed = this.lifecycle("terminate", timeoutMs);
      if (!this.closed) this.rejectClosedWaiters();
      this.closed = true;
      return confirmed;
    }
    return closeAndConfirmRemoteAgentProcess(() => this.close(), this.lifecycle.process, timeoutMs);
  }

  private rejectClosedWaiters(): void {
    this.inbox.rejectWaiters(new RemoteAgentConnectionError("Remote agent connection is closed."));
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    if (this.failure) listener(this.failure);
    return () => this.failureListeners.delete(listener);
  }

  onFrame(listener: FrameListener): () => void {
    this.inbox.listeners.add(listener);
    return () => this.inbox.listeners.delete(listener);
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
        const overflow = this.inbox.deliver(decodeDelimitedFrame(encoded, this.maxFrameBytes));
        if (overflow) {
          this.disconnect(overflow);
          return;
        }
      } catch (error) {
        this.fail(error);
        return;
      }
    }
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
    this.failure =
      error instanceof RemoteAgentConnectionError
        ? error
        : new RemoteAgentConnectionError(
            `Remote agent connection failed: ${error instanceof Error ? error.message : String(error)}`,
            typeof error === "object" && error !== null && "code" in error
              ? (error as NodeJS.ErrnoException).code
              : undefined,
          );
    this.inbox.rejectWaiters(this.failure);
    for (const listener of this.failureListeners) listener(this.failure);
  }
}
