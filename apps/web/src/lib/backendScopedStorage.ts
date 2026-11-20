import { isBoundBackendWindow } from "../rpc/backendScope.state";

/**
 * Backend-scoped persisted storage (WP-3C).
 *
 * A window bound to a remote backend (`?backend=<profileId>`) shares `localStorage` with the
 * local window, so every backend-owned key is namespaced with the same identity as the scoped
 * delivery cursor: `backend-v1:<authorityId>:<installationFingerprint>:<legacy key>`. The local
 * window keeps the legacy keys exactly (empty prefix), so existing users see no change.
 *
 * The bound identity comes from the pinned relay profile, which is only known after the
 * bootstrap lists the relay profiles. Stores are created earlier (module evaluation), so until
 * the identity arrives a bound window's scoped storage is inert: reads return null and writes
 * are dropped. It never falls back to the local keys. Stores that read at creation register a
 * rehydration callback that runs once the identity is set, before the first render.
 */

export const BACKEND_STORAGE_SCHEME = "backend-v1";

export interface BackendStorageIdentity {
  readonly authority: { readonly authorityId: string };
  readonly installationFingerprint: string;
}

export interface ScopedStorage<TRead = string | null> {
  getItem(name: string): TRead | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

interface InnerStorage<TRead> {
  getItem(name: string): TRead | null;
  setItem(name: string, value: string): unknown;
  removeItem(name: string): unknown;
}

let boundPrefix: string | null = null;
const readyListeners = new Set<() => void>();

/** Prefix for one backend identity. Both parts are schema-validated fixed formats (hex id,
 * `sha256:<hex>`), so the colon-separated prefix is unambiguous. */
export function backendStoragePrefix(identity: BackendStorageIdentity): string {
  return `${BACKEND_STORAGE_SCHEME}:${identity.authority.authorityId}:${identity.installationFingerprint}:`;
}

/** `""` in the local window (legacy keys), the backend prefix in a bound window whose identity
 * is known, and `null` in a bound window that does not know its identity yet (inert). */
export function resolveBackendStoragePrefix(): string | null {
  if (boundPrefix !== null) return boundPrefix;
  return isBoundBackendWindow() ? null : "";
}

/** Physical storage key for a logical key, or null while a bound window's identity is pending. */
export function backendScopedKey(key: string): string | null {
  const prefix = resolveBackendStoragePrefix();
  return prefix === null ? null : `${prefix}${key}`;
}

/** Called by the bound-window bootstrap once the pinned identity is known. A window's binding
 * never changes, so a second, different identity is ignored rather than re-keying live state. */
export function setBackendStorageIdentity(identity: BackendStorageIdentity): void {
  const next = backendStoragePrefix(identity);
  if (boundPrefix !== null) {
    if (boundPrefix !== next) console.warn("[storage] Ignoring a second backend identity.");
    return;
  }
  boundPrefix = next;
  const listeners = [...readyListeners];
  readyListeners.clear();
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn("[storage] Backend-scoped rehydration failed.", {
        reason: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}

/** Runs `listener` once the bound identity is set. No-op when the window can already resolve
 * its keys (local window, or identity already known), because creation-time reads were valid. */
export function onBackendStorageReady(listener: () => void): () => void {
  if (resolveBackendStoragePrefix() !== null) return () => undefined;
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

/** Re-reads a zustand `persist` store once a bound window knows its identity. */
export function rehydrateOnBackendStorageReady(store: {
  readonly persist: { readonly rehydrate: () => unknown };
}): void {
  onBackendStorageReady(() => void store.persist.rehydrate());
}

/** Wraps a storage so each call resolves the physical key. Put it outside any debouncing layer
 * so a write issued while the identity is pending is dropped instead of landing later. */
export function createBackendScopedStorage<TRead = string | null>(
  inner: InnerStorage<TRead> | (() => InnerStorage<TRead> | null | undefined),
): ScopedStorage<TRead> {
  const resolveInner = typeof inner === "function" ? inner : () => inner;
  return {
    getItem: (name) => {
      const key = backendScopedKey(name);
      if (key === null) return null;
      return resolveInner()?.getItem(key) ?? null;
    },
    setItem: (name, value) => {
      const key = backendScopedKey(name);
      if (key !== null) resolveInner()?.setItem(key, value);
    },
    removeItem: (name) => {
      const key = backendScopedKey(name);
      if (key !== null) resolveInner()?.removeItem(key);
    },
  };
}

function resolveLocalStorage(): Storage | undefined {
  if (typeof window !== "undefined") return window.localStorage;
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

/** `window.localStorage` (or the global one outside a window), resolved per call, behind the
 * backend scope. Errors from the underlying storage propagate so callers keep their existing
 * quota/private-mode handling. */
export const backendScopedLocalStorage: ScopedStorage =
  createBackendScopedStorage(resolveLocalStorage);

export function __resetBackendScopedStorageForTests(): void {
  boundPrefix = null;
  readyListeners.clear();
}
