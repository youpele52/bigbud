import { RemoteAgentConnectionError, type RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentLifecycle, type RemoteAgentLifecycleSnapshot } from "./remoteAgentLifecycle.ts";
import { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import { RemoteAgentPtyClient } from "./remoteAgentPtyClient.ts";
import { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";
import { remoteAgentRuntimeEqual, type RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import { makeRemoteAgentWorkspaceMutation } from "./remoteAgentWorkspaceMutation.ts";
import { assertRemoteAgentRuntimeHello } from "./remoteAgentCompatibility.ts";
import { RemoteAgentRetirementFence } from "./remoteAgentRetirement.ts";

export interface RemoteAgentRuntimeBinding {
  readonly connectionId?: string;
  readonly runtime: RemoteAgentRuntime;
  readonly expectedEpoch: string;
}

export interface RemoteAgentConnectionPoolFactory {
  readonly create: (
    executionTargetId: string,
    binding?: RemoteAgentRuntimeBinding,
  ) => Promise<RemoteAgentConnection>;
  readonly resolveBinding?: (
    executionTargetId: string,
  ) => Promise<RemoteAgentRuntimeBinding | undefined>;
  /** Durable retirement reservations are a second-controller acquisition fence. */
  readonly isRetiring?: (
    executionTargetId: string,
    binding: RemoteAgentRuntimeBinding,
  ) => Promise<boolean>;
  readonly retirementFence?: RemoteAgentRetirementFence;
}

type Entry = {
  readonly binding?: RemoteAgentRuntimeBinding;
  readonly lifecycle: RemoteAgentLifecycle;
  connecting: Promise<RemoteAgentConnection> | undefined;
  readonly executionTargetId: string;
  closed: boolean;
  transportLost: boolean;
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
  private readonly selectedEntries = new Map<string, Entry>();
  private readonly connectionEntries = new WeakMap<RemoteAgentConnection, Entry>();
  private readonly targetEpochs = new Map<string, number>();

  private readonly retirementFence: RemoteAgentRetirementFence;

  constructor(private readonly factory: RemoteAgentConnectionPoolFactory) {
    this.retirementFence = factory.retirementFence ?? new RemoteAgentRetirementFence();
  }

  async get(executionTargetId: string): Promise<RemoteAgentConnection> {
    const targetEpoch = this.targetEpochs.get(executionTargetId) ?? 0;
    const binding = await this.factory.resolveBinding?.(executionTargetId);
    if (targetEpoch !== (this.targetEpochs.get(executionTargetId) ?? 0))
      throw new RemoteAgentConnectionError(
        "Remote agent connection was invalidated before connection setup completed.",
      );
    const entry = this.entry(executionTargetId, binding);
    this.selectedEntries.set(executionTargetId, entry);
    return this.withAcquisitionFence(
      executionTargetId,
      binding,
      () => this.getEntry(entry),
      this.needsConnection(entry),
    );
  }

  async getBound(
    executionTargetId: string,
    binding: RemoteAgentRuntimeBinding,
    capabilities: ReadonlyArray<string> = [],
  ): Promise<RemoteAgentConnection> {
    const entry = this.entry(executionTargetId, binding);
    const connection = await this.withAcquisitionFence(
      executionTargetId,
      binding,
      () => this.getEntry(entry),
      this.needsConnection(entry),
    );
    const missing = capabilities.find(
      (capability) => !entry.lifecycle.supportsCapability(capability),
    );
    if (missing) throw new RemoteAgentCapabilityError(executionTargetId, missing);
    return connection;
  }

  async beginRetirement(executionTargetId: string, generation: string): Promise<() => void> {
    for (const entry of this.entries.values()) {
      if (
        entry.executionTargetId === executionTargetId &&
        entry.binding?.runtime.generation === generation
      ) {
        return this.retirementFence.begin(generation);
      }
    }
    return this.retirementFence.begin(generation);
  }

  private async getEntry(entry: Entry): Promise<RemoteAgentConnection> {
    if (entry.closed) throw new RemoteAgentConnectionError("Remote agent pool entry is closed.");
    if (entry.lifecycle.connection && entry.lifecycle.snapshot.state === "ready") {
      return entry.lifecycle.connection;
    }
    if (entry.binding && this.retirementFence.isRetiring(entry.binding.runtime.generation))
      throw new RemoteAgentConnectionError("Remote runtime retirement is fenced.");
    if (!entry.connecting) {
      entry.connecting = entry.lifecycle
        .connect({ reconnect: Boolean(entry.lifecycle.snapshot.agentEpoch) })
        .then(() => {
          const connection = entry.lifecycle.connection;
          if (!connection) throw new Error("Remote agent connected without a connection.");
          if (entry.closed || entry.transportLost) {
            const wasTransportLost = entry.transportLost;
            entry.transportLost = false;
            entry.lifecycle.close();
            throw new RemoteAgentConnectionError(
              wasTransportLost
                ? "Remote agent connection was invalidated during connection setup."
                : "Remote agent pool entry was closed during connection setup.",
            );
          }
          this.connectionEntries.set(connection, entry);
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
    const connection = await this.getWithCapabilities(executionTargetId, [
      "workspace.files",
      "workspace.search",
    ]);
    return this.workspaceClient(this.connectionEntries.get(connection)!);
  }

  async getWorkspaceWatchClient(executionTargetId: string): Promise<RemoteAgentWorkspaceClient> {
    const connection = await this.getWithCapabilities(executionTargetId, [
      "workspace.files",
      "workspace.watch",
    ]);
    return this.workspaceClient(this.connectionEntries.get(connection)!);
  }

  private async workspaceClient(entry: Entry): Promise<RemoteAgentWorkspaceClient> {
    return new RemoteAgentWorkspaceClient(
      await this.withAcquisitionFence(
        entry.executionTargetId,
        entry.binding,
        () => this.getEntry(entry),
        this.needsConnection(entry),
      ),
      () => this.workspaceClient(entry),
      entry.binding
        ? makeRemoteAgentWorkspaceMutation(entry.executionTargetId, entry.binding)
        : undefined,
    );
  }

  async getProcessClient(executionTargetId: string): Promise<RemoteAgentProcessClient> {
    const connection = await this.getWithCapabilities(executionTargetId, ["process.run"]);
    return this.processClient(this.connectionEntries.get(connection)!);
  }

  private async processClient(entry: Entry): Promise<RemoteAgentProcessClient> {
    return new RemoteAgentProcessClient(
      await this.withAcquisitionFence(
        entry.executionTargetId,
        entry.binding,
        () => this.getEntry(entry),
        this.needsConnection(entry),
      ),
      () => this.processClient(entry),
    );
  }

  async getPtyClient(executionTargetId: string): Promise<RemoteAgentPtyClient> {
    const connection = await this.getWithCapabilities(executionTargetId, ["terminal.pty"]);
    const entry = this.connectionEntries.get(connection)!;
    return new RemoteAgentPtyClient(connection, () =>
      this.withAcquisitionFence(
        entry.executionTargetId,
        entry.binding,
        () => this.getEntry(entry),
        this.needsConnection(entry),
      ),
    );
  }

  markTransportLoss(executionTargetId: string): void {
    this.targetEpochs.set(executionTargetId, (this.targetEpochs.get(executionTargetId) ?? 0) + 1);
    const entry = this.selectedEntries.get(executionTargetId);
    if (!entry) return;
    if (entry.connecting) {
      entry.transportLost = true;
      return;
    }
    entry.lifecycle.markTransportLoss();
  }

  snapshot(executionTargetId: string): RemoteAgentLifecycleSnapshot {
    return (this.selectedEntries.get(executionTargetId) ?? this.entry(executionTargetId)).lifecycle
      .snapshot;
  }

  close(executionTargetId: string): void {
    this.targetEpochs.set(executionTargetId, (this.targetEpochs.get(executionTargetId) ?? 0) + 1);
    for (const [key, entry] of this.entries) {
      if (entry.executionTargetId !== executionTargetId) continue;
      entry.closed = true;
      entry.lifecycle.close();
      this.entries.delete(key);
    }
    this.selectedEntries.delete(executionTargetId);
  }

  closeAll(): void {
    for (const entry of this.entries.values()) this.close(entry.executionTargetId);
  }

  private entry(executionTargetId: string, binding?: RemoteAgentRuntimeBinding): Entry {
    const key = JSON.stringify([executionTargetId, binding?.runtime.generation ?? "external"]);
    const existing = this.entries.get(key);
    if (existing) {
      if (
        (existing.binding && binding
          ? !remoteAgentRuntimeEqual(existing.binding.runtime, binding.runtime)
          : existing.binding !== binding) ||
        existing.binding?.expectedEpoch !== binding?.expectedEpoch
      )
        throw new Error("Runtime binding identity changed for an existing generation.");
      return existing;
    }
    const entry: Entry = {
      executionTargetId,
      ...(binding ? { binding } : {}),
      lifecycle: new RemoteAgentLifecycle({
        create: () => this.factory.create(executionTargetId, binding),
        ...(binding
          ? {
              expectedEpoch: binding.expectedEpoch,
              validateHello: (hello: import("./remoteAgentProtocol.ts").RemoteAgentHello) =>
                assertRemoteAgentRuntimeHello(binding.runtime, hello),
            }
          : {}),
      }),
      connecting: undefined,
      closed: false,
      transportLost: false,
    };
    this.entries.set(key, entry);
    return entry;
  }

  private async getWithCapabilities(
    executionTargetId: string,
    capabilities: ReadonlyArray<string>,
  ): Promise<RemoteAgentConnection> {
    const connection = await this.get(executionTargetId);
    const lifecycle = this.connectionEntries.get(connection)!.lifecycle;
    const missing = capabilities.find((capability) => !lifecycle.supportsCapability(capability));
    if (missing) throw new RemoteAgentCapabilityError(executionTargetId, missing);
    return connection;
  }

  private async withAcquisitionFence<A>(
    executionTargetId: string,
    binding: RemoteAgentRuntimeBinding | undefined,
    acquire: () => Promise<A>,
    checkRetirement = true,
  ): Promise<A> {
    if (!binding) return acquire();
    const release = this.retirementFence.acquire(binding.runtime.generation);
    try {
      if (checkRetirement && this.factory.isRetiring?.(executionTargetId, binding))
        throw new RemoteAgentConnectionError("Remote runtime retirement is fenced.");
      return await acquire();
    } finally {
      release();
    }
  }

  private needsConnection(entry: Entry): boolean {
    return !entry.lifecycle.connection || entry.lifecycle.snapshot.state !== "ready";
  }
}

export function makeRemoteWorkspaceClientResolver(pool: RemoteAgentConnectionPool) {
  return {
    resolve: (executionTargetId: string) => pool.getWorkspaceClient(executionTargetId),
    resolveWatch: (executionTargetId: string) => pool.getWorkspaceWatchClient(executionTargetId),
  };
}

export function makeRemoteProcessClientResolver(pool: RemoteAgentConnectionPool) {
  return {
    resolve: (executionTargetId: string) => pool.getProcessClient(executionTargetId),
  };
}
