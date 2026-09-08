import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentCapability, RemoteAgentHello } from "./remoteAgentProtocol.ts";

export type RemoteAgentConnectionState =
  | "unavailable"
  | "installing"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "degraded"
  | "authentication-required"
  | "incompatible"
  | "failed";

export interface RemoteAgentLifecycleSnapshot {
  readonly state: RemoteAgentConnectionState;
  readonly agentEpoch?: string;
  readonly agentVersion?: string;
  readonly buildDigest?: string;
  readonly capabilities?: ReadonlyArray<RemoteAgentCapability>;
  readonly maxFrameBytes?: number;
  readonly maxOperationOutputBytes?: number;
  readonly maxJournalBytes?: number;
  readonly detail?: string;
}

export interface RemoteAgentConnectionFactory {
  readonly validateHello?: (hello: RemoteAgentHello) => void;
  readonly create: () => Promise<RemoteAgentConnection>;
  readonly expectedEpoch?: string;
}

export type RemoteAgentDispatchState =
  | "unadmitted"
  | "not-dispatched"
  | "may-have-been-sent"
  | "accepted"
  | "terminal";

export class RemoteAgentLifecycle {
  private snapshotValue: RemoteAgentLifecycleSnapshot = { state: "unavailable" };
  private connectionValue: RemoteAgentConnection | null = null;

  constructor(private readonly factory: RemoteAgentConnectionFactory) {
    if (factory.expectedEpoch)
      this.snapshotValue = { state: "unavailable", agentEpoch: factory.expectedEpoch };
  }

  get snapshot(): RemoteAgentLifecycleSnapshot {
    return this.snapshotValue;
  }

  get connection(): RemoteAgentConnection | null {
    return this.connectionValue;
  }

  markInstalling(): void {
    this.snapshotValue = { state: "installing" };
  }

  async connect(options?: { readonly reconnect?: boolean }): Promise<RemoteAgentHello> {
    const previousEpoch = this.snapshotValue.agentEpoch;
    this.snapshotValue = {
      state: options?.reconnect ? "reconnecting" : "connecting",
      ...(previousEpoch ? { agentEpoch: previousEpoch } : {}),
    };
    try {
      const connection = await this.factory.create();
      let hello: RemoteAgentHello;
      try {
        hello = await connection.handshake();
        this.factory.validateHello?.(hello);
      } catch (error) {
        connection.close();
        throw error;
      }
      if (previousEpoch && previousEpoch !== hello.agentEpoch) {
        connection.close();
        this.connectionValue = null;
        this.snapshotValue = {
          state: "degraded",
          detail: "Remote agent epoch changed; retained operation continuity is unknown.",
          agentEpoch: previousEpoch,
        };
        throw new Error(this.snapshotValue.detail);
      }
      this.connectionValue = connection;
      this.snapshotValue = {
        state: "ready",
        agentEpoch: hello.agentEpoch,
        agentVersion: hello.agentVersion,
        buildDigest: hello.buildDigest,
        capabilities: hello.capabilities,
        maxFrameBytes: hello.maxFrameBytes,
        maxOperationOutputBytes: hello.maxOperationOutputBytes,
        maxJournalBytes: hello.maxJournalBytes,
      };
      return hello;
    } catch (error) {
      if (this.snapshotValue.state !== "degraded") {
        this.snapshotValue = {
          state: /password|passphrase|authentication|permission denied/i.test(
            error instanceof Error ? error.message : String(error),
          )
            ? "authentication-required"
            : "failed",
          detail: error instanceof Error ? error.message : String(error),
          ...(this.snapshotValue.agentEpoch ? { agentEpoch: this.snapshotValue.agentEpoch } : {}),
        };
      }
      throw error;
    }
  }

  markTransportLoss(): void {
    if (this.snapshotValue.state === "ready") {
      this.connectionValue?.close();
      this.connectionValue = null;
      this.snapshotValue = {
        state: "reconnecting",
        ...(this.snapshotValue.agentEpoch ? { agentEpoch: this.snapshotValue.agentEpoch } : {}),
      };
    }
  }

  markIncompatible(detail: string): void {
    this.snapshotValue = {
      state: "incompatible",
      detail,
      ...(this.snapshotValue.agentEpoch ? { agentEpoch: this.snapshotValue.agentEpoch } : {}),
    };
  }

  supportsCapability(name: string, major = 1): boolean {
    return (
      this.snapshotValue.capabilities?.some(
        (capability) => capability.name === name && capability.major === major,
      ) ?? false
    );
  }

  canFallback(state: RemoteAgentDispatchState): boolean {
    return state === "unadmitted";
  }

  close(): void {
    this.connectionValue?.close();
    this.connectionValue = null;
    this.snapshotValue = { state: "unavailable" };
  }
}
