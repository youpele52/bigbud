export interface LedgerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface RevisionedLedger {
  readonly revision: number;
  readonly lastMutationId: string;
}

export type LedgerReadResult<T> =
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "unavailable"; readonly reason: "corrupt" | "storage" };

export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

const localMutationTails = new Map<string, Promise<void>>();
const sameWindowListeners = new Map<string, Set<(revision: number) => void>>();

export function resolveLedgerStorage(): LedgerStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

function newMutationId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function withLocalSerialization<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = localMutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  localMutationTails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (localMutationTails.get(key) === tail) localMutationTails.delete(key);
  }
}

function defaultLockManager(): LockManagerLike | null {
  if (typeof navigator === "undefined" || !("locks" in navigator)) return null;
  return navigator.locks as LockManagerLike;
}

function publishChange(channelName: string, revision: number): void {
  for (const listener of sameWindowListeners.get(channelName) ?? []) listener(revision);
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel(channelName);
    // BroadcastChannel.postMessage has no targetOrigin; oxlint models Window.postMessage.
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    channel.postMessage({ revision });
    channel.close();
  } catch (error) {
    console.warn("[ledger] Cross-window notification failed.", {
      channelName,
      reason: error instanceof Error ? error.name : "unknown",
    });
  }
}

export async function mutateRevisionedLedger<TLedger extends RevisionedLedger, TResult>(input: {
  readonly key: string;
  readonly channelName: string;
  readonly storage?: LedgerStorage | null;
  readonly lockManager?: LockManagerLike | null;
  readonly read: (storage: LedgerStorage | null) => LedgerReadResult<TLedger>;
  readonly mutate: (
    ledger: TLedger,
    mutationId: string,
  ) => { readonly ledger: TLedger; readonly result: TResult };
}): Promise<TResult> {
  const storage = input.storage === undefined ? resolveLedgerStorage() : input.storage;
  const lockManager = input.lockManager === undefined ? defaultLockManager() : input.lockManager;
  const operation = async (): Promise<TResult> => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = input.read(storage);
      if (current.status === "unavailable") {
        throw new Error(`Ledger unavailable: ${current.reason}`);
      }
      const mutationId = newMutationId();
      const mutation = input.mutate(current.value, mutationId);
      if (mutation.ledger === current.value) return mutation.result;
      try {
        storage?.setItem(input.key, JSON.stringify(mutation.ledger));
      } catch {
        throw new Error("Ledger unavailable: storage");
      }
      const verified = input.read(storage);
      if (
        verified.status === "ready" &&
        verified.value.lastMutationId === mutationId &&
        verified.value.revision === mutation.ledger.revision
      ) {
        publishChange(input.channelName, mutation.ledger.revision);
        return mutation.result;
      }
    }
    throw new Error("Ledger unavailable: concurrent-write");
  };
  if (lockManager) return lockManager.request(`bigbud:${input.key}:write`, operation);
  return withLocalSerialization(input.key, operation);
}

export function subscribeToLedgerChanges(input: {
  readonly key: string;
  readonly channelName: string;
  readonly listener: (revision: number) => void;
}): () => void {
  const listeners = sameWindowListeners.get(input.channelName) ?? new Set();
  listeners.add(input.listener);
  sameWindowListeners.set(input.channelName, listeners);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== input.key || event.newValue === null) return;
    try {
      const revision = (JSON.parse(event.newValue) as { revision?: unknown }).revision;
      if (Number.isSafeInteger(revision)) input.listener(revision as number);
    } catch {
      input.listener(-1);
    }
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(input.channelName);
      channel.addEventListener("message", (event) => {
        const revision = (event.data as { revision?: unknown } | null)?.revision;
        if (Number.isSafeInteger(revision)) input.listener(revision as number);
      });
    } catch (error) {
      console.warn("[ledger] Cross-window subscription failed.", {
        channelName: input.channelName,
        reason: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return () => {
    listeners.delete(input.listener);
    if (listeners.size === 0) sameWindowListeners.delete(input.channelName);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
    channel?.close();
  };
}
