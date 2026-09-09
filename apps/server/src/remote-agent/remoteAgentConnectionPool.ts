import { RemoteAgentConnectionError, type RemoteAgentConnection } from "./remoteAgentConnection.ts";
import {
  RemoteAgentCapabilityError,
  REMOTE_SERVICE_RESTARTED,
  isRemoteAgentRestartError,
} from "./remoteAgentConnectionPool.errors.ts";
export {
  RemoteAgentCapabilityError,
  REMOTE_SERVICE_RESTARTED,
  isRemoteAgentRestartError,
} from "./remoteAgentConnectionPool.errors.ts";
import { RemoteAgentLifecycle, type RemoteAgentLifecycleSnapshot } from "./remoteAgentLifecycle.ts";
import { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import { RemoteAgentPtyClient } from "./remoteAgentPtyClient.ts";
import { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";
import { remoteAgentRuntimeEqual, type RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import { makeRemoteAgentWorkspaceMutation } from "./remoteAgentWorkspaceMutation.ts";
import { assertRemoteAgentRuntimeHello } from "./remoteAgentCompatibility.ts";
import { RemoteAgentRetirementFence } from "./remoteAgentRetirement.ts";
import type { Entry } from "./remoteAgentConnectionPool.entry.ts";

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
  readonly isRetiring?: (
    executionTargetId: string,
    binding: RemoteAgentRuntimeBinding,
  ) => Promise<boolean>;
  readonly retirementFence?: RemoteAgentRetirementFence;
}

export class RemoteAgentConnectionPool {
  private readonly entries = new Map<string, Entry>();
  private readonly selectedEntries = new Map<string, Entry>();
  private readonly connectionEntries = new WeakMap<RemoteAgentConnection, Entry>();
  private readonly targetEpochs = new Map<string, number>();
  private readonly invalidatedBindings = new Set<string>();
  private readonly restartListeners = new Map<string, Set<() => void>>();

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
    if (binding && this.invalidatedBindings.has(this.bindingKey(executionTargetId, binding)))
      throw new RemoteAgentConnectionError(REMOTE_SERVICE_RESTARTED);
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
    if (this.invalidatedBindings.has(this.bindingKey(executionTargetId, binding)))
      throw new RemoteAgentConnectionError(REMOTE_SERVICE_RESTARTED);
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
  /** Admit only a verified new epoch while the prior generation remains fenced. */
  async admitReplacement(
    executionTargetId: string,
    replacement: RemoteAgentRuntimeBinding,
    retired: RemoteAgentRuntimeBinding,
  ): Promise<RemoteAgentConnection> {
    if (
      replacement.runtime.generation !== retired.runtime.generation ||
      replacement.expectedEpoch === retired.expectedEpoch
    )
      throw new RemoteAgentConnectionError("Replacement runtime identity is not a new epoch.");
    if (this.invalidatedBindings.has(this.bindingKey(executionTargetId, replacement)))
      throw new RemoteAgentConnectionError(REMOTE_SERVICE_RESTARTED);
    const entry = this.entry(executionTargetId, replacement);
    this.selectedEntries.set(executionTargetId, entry);
    return this.getEntry(entry, true);
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
  private async getEntry(
    entry: Entry,
    replacementAdmission = false,
  ): Promise<RemoteAgentConnection> {
    if (entry.closed) throw new RemoteAgentConnectionError("Remote agent pool entry is closed.");
    if (entry.lifecycle.connection && entry.lifecycle.snapshot.state === "ready") {
      return entry.lifecycle.connection;
    }
    if (
      !replacementAdmission &&
      entry.binding &&
      this.retirementFence.isRetiring(entry.binding.runtime.generation)
    )
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

  closeBound(executionTargetId: string, binding: RemoteAgentRuntimeBinding): void {
    const bindingKey = this.bindingKey(executionTargetId, binding);
    this.invalidatedBindings.add(bindingKey);
    const runtimeKey = this.runtimeKey(binding);
    for (const [key, listeners] of this.restartListeners) {
      if (!key.endsWith(runtimeKey)) continue;
      for (const listener of listeners) listener();
      this.restartListeners.delete(key);
    }
    const affectedTargets = new Set<string>([executionTargetId]);
    for (const [key, entry] of this.entries) {
      if (
        !entry.binding ||
        entry.binding.runtime.generation !== binding.runtime.generation ||
        entry.binding.expectedEpoch !== binding.expectedEpoch ||
        !remoteAgentRuntimeEqual(entry.binding.runtime, binding.runtime)
      )
        continue;
      affectedTargets.add(entry.executionTargetId);
      this.invalidatedBindings.add(this.bindingKey(entry.executionTargetId, binding));
      entry.closed = true;
      entry.lifecycle.close();
      this.entries.delete(key);
    }
    for (const target of affectedTargets) {
      this.targetEpochs.set(target, (this.targetEpochs.get(target) ?? 0) + 1);
      const selected = this.selectedEntries.get(target);
      if (
        selected?.binding &&
        selected.binding.runtime.generation === binding.runtime.generation &&
        selected.binding.expectedEpoch === binding.expectedEpoch &&
        remoteAgentRuntimeEqual(selected.binding.runtime, binding.runtime)
      )
        this.selectedEntries.delete(target);
    }
  }
  onRuntimeRestart(binding: RemoteAgentRuntimeBinding, listener: () => void): () => void {
    const key = `runtime:${this.runtimeKey(binding)}`;
    const listeners = this.restartListeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.restartListeners.set(key, listeners);
    return () =>
      void (
        listeners.delete(listener) &&
        listeners.size === 0 &&
        this.restartListeners.delete(key)
      );
  }
  reconcileRuntimeResources(executionTargetId: string, binding: RemoteAgentRuntimeBinding): void {
    this.closeBound(executionTargetId, binding);
  }
  closeAll(): void {
    for (const entry of this.entries.values()) this.close(entry.executionTargetId);
  }
  private entry(executionTargetId: string, binding?: RemoteAgentRuntimeBinding): Entry {
    const key = JSON.stringify([
      executionTargetId,
      binding
        ? [
            binding.runtime.generation,
            binding.expectedEpoch,
            binding.runtime.buildDigest,
            binding.runtime.socketPath,
          ]
        : "external",
    ]);
    const existing = this.entries.get(key);
    if (existing) {
      if (
        (existing.binding && binding
          ? !remoteAgentRuntimeEqual(existing.binding.runtime, binding.runtime)
          : existing.binding !== binding) ||
        existing.binding?.expectedEpoch !== binding?.expectedEpoch
      )
        throw new Error("Runtime binding identity changed for an existing resource.");
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

  private bindingKey(executionTargetId: string, binding: RemoteAgentRuntimeBinding): string {
    return JSON.stringify([executionTargetId, this.runtimeKey(binding)]);
  }

  private runtimeKey(binding: RemoteAgentRuntimeBinding): string {
    return JSON.stringify([
      binding.runtime.generation,
      binding.expectedEpoch,
      binding.runtime.buildDigest,
      binding.runtime.socketPath,
    ]);
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
      if (checkRetirement && (await this.factory.isRetiring?.(executionTargetId, binding)))
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
