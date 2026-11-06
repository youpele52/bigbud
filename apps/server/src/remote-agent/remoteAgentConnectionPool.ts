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
import type { RemoteAgentLifecycleSnapshot } from "./remoteAgentLifecycle.ts";
import { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import { RemoteAgentPtyClient } from "./remoteAgentPtyClient.ts";
import { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";
import { remoteAgentRuntimeEqual, type RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import { makeRemoteAgentWorkspaceMutation } from "./remoteAgentWorkspaceMutation.ts";
import { RemoteAgentRetirementFence } from "./remoteAgentRetirement.ts";
import { type Entry, makeRemoteAgentPoolEntry } from "./remoteAgentConnectionPool.entry.ts";
import {
  remoteAgentPoolBindingKey,
  remoteAgentPoolEntryKey,
  remoteAgentPoolRuntimeKey,
} from "./remoteAgentConnectionPool.keys.ts";
import { assertSshTargetConnected } from "../ssh/sshTargetDisconnects.ts";

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
    assertSshTargetConnected(executionTargetId);
    const targetEpoch = this.targetEpochs.get(executionTargetId) ?? 0;
    const binding = await this.factory.resolveBinding?.(executionTargetId);
    if (targetEpoch !== (this.targetEpochs.get(executionTargetId) ?? 0))
      throw new RemoteAgentConnectionError(
        "Remote agent connection was invalidated before connection setup completed.",
      );
    if (
      binding &&
      this.invalidatedBindings.has(remoteAgentPoolBindingKey(executionTargetId, binding))
    )
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
    assertSshTargetConnected(executionTargetId);
    if (this.invalidatedBindings.has(remoteAgentPoolBindingKey(executionTargetId, binding)))
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
    if (this.invalidatedBindings.has(remoteAgentPoolBindingKey(executionTargetId, replacement)))
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
            // A lost transport keeps the agent epoch so a later reconnect still verifies it.
            if (wasTransportLost && !entry.closed) entry.lifecycle.markTransportLoss();
            else entry.lifecycle.close();
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
          // A setup that failed never reached the check above; the loss is already applied.
          entry.transportLost = false;
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

  /**
   * User disconnect: fails each live connection for the target with `error` so consumers
   * see an ordinary transport loss, and invalidates setups in flight. Entries and their
   * agent epochs are kept, so reattach resumes through them after Connect.
   */
  disconnect(executionTargetId: string, error: Error): void {
    this.targetEpochs.set(executionTargetId, (this.targetEpochs.get(executionTargetId) ?? 0) + 1);
    for (const entry of this.entries.values()) {
      if (entry.executionTargetId !== executionTargetId) continue;
      if (entry.connecting) entry.transportLost = true;
      // A connection still in handshake is failed too, so its SSH child does not linger.
      for (const connection of [entry.lifecycle.connection, entry.lifecycle.pendingConnection]) {
        if (connection && typeof connection.disconnect === "function") connection.disconnect(error);
      }
      entry.lifecycle.markTransportLoss();
    }
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
    const bindingKey = remoteAgentPoolBindingKey(executionTargetId, binding);
    this.invalidatedBindings.add(bindingKey);
    const runtimeKey = remoteAgentPoolRuntimeKey(binding);
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
      this.invalidatedBindings.add(remoteAgentPoolBindingKey(entry.executionTargetId, binding));
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
    const key = `runtime:${remoteAgentPoolRuntimeKey(binding)}`;
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
    const key = remoteAgentPoolEntryKey(executionTargetId, binding);
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
    const entry = makeRemoteAgentPoolEntry(executionTargetId, binding, () =>
      this.factory.create(executionTargetId, binding),
    );
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
    // Reconnect closures of process, PTY and workspace clients reacquire through here.
    assertSshTargetConnected(executionTargetId);
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
