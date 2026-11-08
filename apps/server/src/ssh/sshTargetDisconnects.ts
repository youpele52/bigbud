/**
 * User-initiated disconnects for SSH execution targets.
 *
 * A disconnected target is a deliberate, sticky network loss: every SSH spawn
 * or connection attempt for it fails fast with `RemoteTargetDisconnectedError`
 * before any local or network probe runs. The flag is persisted by the
 * configured store (SQLite in the server) and mirrored here so the guard stays
 * synchronous. Remote-agent reattach treats the error as a retryable transport
 * interruption, so remote work keeps waiting until the user connects again.
 */

export const REMOTE_TARGET_DISCONNECTED_MESSAGE =
  "Remote workspace is disconnected. Connect it to continue.";
export const REMOTE_TARGET_DISCONNECTED_CODE = "REMOTE_TARGET_DISCONNECTED";

export class RemoteTargetDisconnectedError extends Error {
  readonly _tag = "RemoteTargetDisconnectedError";
  readonly code = REMOTE_TARGET_DISCONNECTED_CODE;

  constructor(readonly executionTargetId: string) {
    super(REMOTE_TARGET_DISCONNECTED_MESSAGE);
    this.name = "RemoteTargetDisconnectedError";
  }
}

export interface SshTargetDisconnectStore {
  /** Records the flag durably; must be idempotent for an already recorded target. */
  readonly persist: (executionTargetId: string, disconnectedAt: number) => Promise<void>;
  readonly remove: (executionTargetId: string) => Promise<void>;
}

const disconnectedTargets = new Set<string>();
const pendingChanges = new Map<string, Promise<void>>();
let configuredStore: SshTargetDisconnectStore | undefined;

/**
 * Installs the durable store and replaces the in-memory flags with the loaded
 * ones. Without a store (tests and fixtures) flags are process-local only.
 */
export function configureSshTargetDisconnects(
  store: SshTargetDisconnectStore | undefined,
  loadedTargets: Iterable<string>,
): void {
  configuredStore = store;
  disconnectedTargets.clear();
  for (const target of loadedTargets) disconnectedTargets.add(target);
}

/** Detaches `store` if it is still the configured one; loaded flags stay in force. */
export function releaseSshTargetDisconnectStore(store: SshTargetDisconnectStore): void {
  if (configuredStore === store) configuredStore = undefined;
}

export function isSshTargetDisconnected(executionTargetId: string | null | undefined): boolean {
  return executionTargetId != null && disconnectedTargets.has(executionTargetId);
}

/** The guard every SSH spawn path runs first. Throws `RemoteTargetDisconnectedError`. */
export function assertSshTargetConnected(executionTargetId: string | null | undefined): void {
  if (isSshTargetDisconnected(executionTargetId)) {
    throw new RemoteTargetDisconnectedError(executionTargetId!);
  }
}

export function listDisconnectedSshTargets(): ReadonlyArray<string> {
  return [...disconnectedTargets].toSorted();
}

/** Serializes changes per target so a concurrent connect and disconnect cannot split store and memory. */
function serialized<A>(executionTargetId: string, change: () => Promise<A>): Promise<A> {
  const previous = pendingChanges.get(executionTargetId) ?? Promise.resolve();
  const result = previous.then(change);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  pendingChanges.set(executionTargetId, settled);
  void settled.then(() => {
    if (pendingChanges.get(executionTargetId) === settled) pendingChanges.delete(executionTargetId);
  });
  return result;
}

/**
 * Persists the flag, then enforces it in memory. A persistence failure rejects
 * and leaves the target connected. Resolves `false` when it was already set.
 */
export function markSshTargetDisconnected(executionTargetId: string): Promise<boolean> {
  return serialized(executionTargetId, async () => {
    if (disconnectedTargets.has(executionTargetId)) return false;
    await configuredStore?.persist(executionTargetId, Date.now());
    disconnectedTargets.add(executionTargetId);
    return true;
  });
}

/**
 * Removes the durable flag, then lifts the guard. A persistence failure rejects
 * and leaves the target disconnected. Resolves `false` when it was not set.
 */
export function clearSshTargetDisconnected(executionTargetId: string): Promise<boolean> {
  return serialized(executionTargetId, async () => {
    if (!disconnectedTargets.has(executionTargetId)) return false;
    await configuredStore?.remove(executionTargetId);
    disconnectedTargets.delete(executionTargetId);
    return true;
  });
}
