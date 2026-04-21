import { Debouncer } from "@tanstack/react-pacer";

export interface StateStorage<R = unknown> {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => R;
  removeItem: (name: string) => R;
}

export interface DebouncedStorage<R = unknown> extends StateStorage<R> {
  flush: () => void;
}

interface ResolveStorageOptions {
  readonly legacyKeysByName?: Record<string, ReadonlyArray<string>>;
}

export function createMemoryStorage(): StateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
}

export function isStateStorage(
  storage: Partial<StateStorage> | null | undefined,
): storage is StateStorage {
  return (
    storage !== null &&
    storage !== undefined &&
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function" &&
    typeof storage.removeItem === "function"
  );
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}

function migrateLegacyItem(storage: StateStorage, name: string, legacyKey: string, value: string) {
  storage.setItem(name, value);
  storage.removeItem(legacyKey);
  return value;
}

function readLegacyItem(
  storage: StateStorage,
  name: string,
  legacyKeys: ReadonlyArray<string>,
): string | null | Promise<string | null> {
  const [legacyKey, ...remainingKeys] = legacyKeys;
  if (!legacyKey) {
    return null;
  }

  const legacyItem = storage.getItem(legacyKey);
  if (isPromiseLike(legacyItem)) {
    return legacyItem.then((resolvedLegacyItem) => {
      if (resolvedLegacyItem !== null) {
        return migrateLegacyItem(storage, name, legacyKey, resolvedLegacyItem);
      }
      return readLegacyItem(storage, name, remainingKeys);
    });
  }

  if (legacyItem !== null) {
    return migrateLegacyItem(storage, name, legacyKey, legacyItem);
  }

  return readLegacyItem(storage, name, remainingKeys);
}

function wrapStorageWithLegacyAliases(
  storage: StateStorage,
  legacyKeysByName: Record<string, ReadonlyArray<string>>,
): StateStorage {
  return {
    getItem: (name) => {
      const item = storage.getItem(name);
      if (isPromiseLike(item)) {
        return item.then((resolvedItem) => {
          if (resolvedItem !== null) {
            return resolvedItem;
          }
          return readLegacyItem(storage, name, legacyKeysByName[name] ?? []);
        });
      }

      if (item !== null) return item;

      return readLegacyItem(storage, name, legacyKeysByName[name] ?? []);
    },
    setItem: (name, value) => {
      const result = storage.setItem(name, value);
      for (const legacyKey of legacyKeysByName[name] ?? []) {
        storage.removeItem(legacyKey);
      }
      return result;
    },
    removeItem: (name) => {
      const result = storage.removeItem(name);
      for (const legacyKey of legacyKeysByName[name] ?? []) {
        storage.removeItem(legacyKey);
      }
      return result;
    },
  };
}

export function resolveStorage(
  storage: Partial<StateStorage> | null | undefined,
  options?: ResolveStorageOptions,
): StateStorage {
  const resolved = isStateStorage(storage) ? storage : createMemoryStorage();
  if (!options?.legacyKeysByName) return resolved;
  return wrapStorageWithLegacyAliases(resolved, options.legacyKeysByName);
}

export function createDebouncedStorage(
  baseStorage: Partial<StateStorage> | null | undefined,
  debounceMs: number = 300,
): DebouncedStorage {
  const resolvedStorage = resolveStorage(baseStorage);
  const debouncedSetItem = new Debouncer(
    (name: string, value: string) => {
      resolvedStorage.setItem(name, value);
    },
    { wait: debounceMs },
  );

  return {
    getItem: (name) => resolvedStorage.getItem(name),
    setItem: (name, value) => {
      debouncedSetItem.maybeExecute(name, value);
    },
    removeItem: (name) => {
      debouncedSetItem.cancel();
      resolvedStorage.removeItem(name);
    },
    flush: () => {
      debouncedSetItem.flush();
    },
  };
}
