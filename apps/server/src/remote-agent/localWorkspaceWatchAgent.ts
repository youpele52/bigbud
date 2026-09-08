import type { RemoteAgentHello } from "./remoteAgentProtocol.ts";
import { RemoteAgentConnection, RemoteAgentConnectionError } from "./remoteAgentConnection.ts";
import { RemoteAgentCapabilityError } from "./remoteAgentConnectionPool.ts";
import { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";
import {
  LocalWorkspaceWatchAgentUnavailableError,
  resolveLocalWorkspaceWatchAgentBinary,
} from "./localWorkspaceWatchAgent.binary.ts";

const DEFAULT_RESTART_DELAY_MS = 250;
const MAX_RESTART_DELAY_MS = 30_000;
const STABLE_CONNECTION_MS = 30_000;
const noop = () => {};

interface LiveConnection {
  readonly connection: RemoteAgentConnection;
  readonly hello: RemoteAgentHello;
  readonly removeFailureListener: () => void;
}

export interface LocalWorkspaceWatchAgentOptions {
  readonly resolveBinary?: () => string;
  readonly createConnection?: (binaryPath: string) => RemoteAgentConnection;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly restartDelayMs?: number;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function supportsCapability(hello: RemoteAgentHello, name: string): boolean {
  return hello.capabilities.some(
    (capability) => capability.name === name && capability.major === 1,
  );
}

export class LocalWorkspaceWatchAgent {
  private readonly resolveBinary: () => string;
  private readonly createConnection: (binaryPath: string) => RemoteAgentConnection;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly restartDelayMs: number;
  private live: LiveConnection | null = null;
  private connecting: RemoteAgentConnection | null = null;
  private starting: Promise<RemoteAgentConnection> | null = null;
  private closed = false;
  private failureCount = 0;
  private retryAt = 0;
  private readonly closeController = new AbortController();

  constructor(options: LocalWorkspaceWatchAgentOptions = {}) {
    this.resolveBinary = options.resolveBinary ?? resolveLocalWorkspaceWatchAgentBinary;
    this.createConnection =
      options.createConnection ??
      ((binaryPath) => RemoteAgentConnection.local({ binaryPath, args: ["--ephemeral"] }));
    this.wait = options.wait ?? wait;
    this.now = options.now ?? Date.now;
    this.restartDelayMs = Math.max(
      1,
      Math.floor(options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS),
    );
  }

  get processId(): number | undefined {
    return this.live?.connection.processId;
  }

  get agentEpoch(): string | undefined {
    return this.live?.hello.agentEpoch;
  }

  async getWorkspaceClient(): Promise<RemoteAgentWorkspaceClient> {
    return new RemoteAgentWorkspaceClient(await this.getConnection());
  }

  async getConnection(): Promise<RemoteAgentConnection> {
    if (this.closed) {
      throw new LocalWorkspaceWatchAgentUnavailableError(
        "Local workspace watcher agent is closed.",
      );
    }
    if (this.live) return this.live.connection;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeController.abort();
    const connecting = this.connecting;
    this.connecting = null;
    const live = this.live;
    this.live = null;
    connecting?.close();
    live?.removeFailureListener();
    live?.connection.close();
  }

  private async start(): Promise<RemoteAgentConnection> {
    const retryDelay = Math.max(0, this.retryAt - this.now());
    if (retryDelay > 0) await this.wait(retryDelay, this.closeController.signal);
    if (this.closed) {
      throw new RemoteAgentConnectionError("Local workspace watcher agent is closed.");
    }

    const connection = this.createConnection(this.resolveBinary());
    this.connecting = connection;
    let transportFailure: Error | undefined;
    try {
      const hello = await connection.handshake();
      for (const capability of ["workspace.files", "workspace.watch"]) {
        if (!supportsCapability(hello, capability)) {
          throw new RemoteAgentCapabilityError("local", capability);
        }
      }
      if (this.closed) {
        connection.close();
        throw new RemoteAgentConnectionError("Local workspace watcher agent is closed.");
      }
      let removeFailureListener = noop;
      const live: LiveConnection = {
        connection,
        hello,
        removeFailureListener: () => removeFailureListener(),
      };
      this.connecting = null;
      this.live = live;
      const readyAt = this.now();
      removeFailureListener = connection.onFailure((error) => {
        transportFailure = error;
        if (this.live?.connection !== connection) return;
        this.live.removeFailureListener();
        this.live = null;
        if (this.now() - readyAt >= STABLE_CONNECTION_MS) this.failureCount = 0;
        this.recordFailure();
      });
      if (transportFailure) throw transportFailure;
      this.retryAt = 0;
      return connection;
    } catch (error) {
      if (this.connecting === connection) this.connecting = null;
      if (this.live?.connection === connection) {
        this.live.removeFailureListener();
        this.live = null;
        this.recordFailure();
      }
      connection.close();
      if (!transportFailure && !this.closed) this.recordFailure();
      throw error;
    }
  }

  private recordFailure(): void {
    const exponent = Math.min(this.failureCount, 8);
    this.failureCount += 1;
    this.retryAt = this.now() + Math.min(MAX_RESTART_DELAY_MS, this.restartDelayMs * 2 ** exponent);
  }
}
