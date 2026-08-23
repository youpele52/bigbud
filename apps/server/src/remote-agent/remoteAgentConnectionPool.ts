import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentLifecycle, type RemoteAgentLifecycleSnapshot } from "./remoteAgentLifecycle.ts";
import { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import { RemoteAgentPtyClient } from "./remoteAgentPtyClient.ts";
import { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";

export interface RemoteAgentConnectionPoolFactory {
  readonly create: (executionTargetId: string) => Promise<RemoteAgentConnection>;
}

type Entry = {
  readonly lifecycle: RemoteAgentLifecycle;
  connecting: Promise<RemoteAgentConnection> | undefined;
};

export class RemoteAgentCapabilityError extends Error {
  readonly _tag = "RemoteAgentCapabilityError";

  constructor(
    readonly executionTargetId: string,
    readonly capability: string,
  ) {
    super(`Remote agent '${executionTargetId}' does not advertise capability '${capability}'.`);
    this.name = "RemoteAgentCapabilityError";
  }
}

export class RemoteAgentConnectionPool {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly factory: RemoteAgentConnectionPoolFactory) {}

  async get(executionTargetId: string): Promise<RemoteAgentConnection> {
    const entry = this.entry(executionTargetId);
    if (entry.lifecycle.connection && entry.lifecycle.snapshot.state === "ready") {
      return entry.lifecycle.connection;
    }
    if (!entry.connecting) {
      entry.connecting = entry.lifecycle
        .connect({ reconnect: Boolean(entry.lifecycle.snapshot.agentEpoch) })
        .then(() => {
          const connection = entry.lifecycle.connection;
          if (!connection) throw new Error("Remote agent connected without a connection.");
          if (typeof connection.onFailure === "function") {
            connection.onFailure(() => {
              if (entry.lifecycle.connection === connection) {
                entry.lifecycle.markTransportLoss();
              }
            });
          }
          return connection;
        })
        .finally(() => {
          entry.connecting = undefined;
        });
    }
    return entry.connecting;
  }

  async getWorkspaceClient(executionTargetId: string): Promise<RemoteAgentWorkspaceClient> {
    return new RemoteAgentWorkspaceClient(
      await this.getWithCapabilities(executionTargetId, ["workspace.files", "workspace.search"]),
    );
  }

  async getProcessClient(executionTargetId: string): Promise<RemoteAgentProcessClient> {
    return new RemoteAgentProcessClient(
      await this.getWithCapabilities(executionTargetId, ["process.run"]),
      () => this.getProcessClient(executionTargetId),
    );
  }

  async getPtyClient(executionTargetId: string): Promise<RemoteAgentPtyClient> {
    return new RemoteAgentPtyClient(
      await this.getWithCapabilities(executionTargetId, ["terminal.pty"]),
      () => this.get(executionTargetId),
    );
  }

  markTransportLoss(executionTargetId: string): void {
    this.entries.get(executionTargetId)?.lifecycle.markTransportLoss();
  }

  snapshot(executionTargetId: string): RemoteAgentLifecycleSnapshot {
    return this.entry(executionTargetId).lifecycle.snapshot;
  }

  close(executionTargetId: string): void {
    const entry = this.entries.get(executionTargetId);
    if (!entry) return;
    entry.lifecycle.close();
    this.entries.delete(executionTargetId);
  }

  closeAll(): void {
    for (const executionTargetId of this.entries.keys()) this.close(executionTargetId);
  }

  private entry(executionTargetId: string): Entry {
    const existing = this.entries.get(executionTargetId);
    if (existing) return existing;
    const entry: Entry = {
      lifecycle: new RemoteAgentLifecycle({
        create: () => this.factory.create(executionTargetId),
      }),
      connecting: undefined,
    };
    this.entries.set(executionTargetId, entry);
    return entry;
  }

  private async getWithCapabilities(
    executionTargetId: string,
    capabilities: ReadonlyArray<string>,
  ): Promise<RemoteAgentConnection> {
    const connection = await this.get(executionTargetId);
    const lifecycle = this.entry(executionTargetId).lifecycle;
    const missing = capabilities.find((capability) => !lifecycle.supportsCapability(capability));
    if (missing) throw new RemoteAgentCapabilityError(executionTargetId, missing);
    return connection;
  }
}

export function makeRemoteWorkspaceClientResolver(pool: RemoteAgentConnectionPool) {
  return {
    resolve: (executionTargetId: string) => pool.getWorkspaceClient(executionTargetId),
  };
}

export function makeRemoteProcessClientResolver(pool: RemoteAgentConnectionPool) {
  return {
    resolve: (executionTargetId: string) => pool.getProcessClient(executionTargetId),
  };
}
