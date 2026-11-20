import * as Schema from "effect/Schema";
import * as Record from "effect/Record";
import { useCallback, useEffect, useRef, useState } from "react";
import { backendScopedKey, createBackendScopedStorage } from "../lib/backendScopedStorage";

interface LocalStorageKeyOptions {
  readonly legacyKeys?: ReadonlyArray<string>;
  /** `"backend"` namespaces the key (and legacy keys) to the window's bound backend; the local
   * window still uses the plain key. Omit for device-global preferences. */
  readonly scope?: "backend";
}

interface LocalStorageOptions<T> extends LocalStorageKeyOptions {
  readonly migrateLegacyValue?: (value: T) => T;
}

/** Stable options object for backend-owned values (safe as a hook dependency). */
export const BACKEND_SCOPED_STORAGE_OPTIONS = { scope: "backend" } as const;

const isomorphicLocalStorage: Storage =
  typeof window !== "undefined"
    ? window.localStorage
    : (function () {
        const store = new Map<string, string>();
        return {
          clear: () => store.clear(),
          getItem: (_) => store.get(_) ?? null,
          key: (_) => Record.keys(store).at(_) ?? null,
          get length() {
            return store.size;
          },
          removeItem: (_) => store.delete(_),
          setItem: (_, value) => store.set(_, value),
        };
      })();
const backendScopedIsomorphicStorage = createBackendScopedStorage(() => isomorphicLocalStorage);

function storageFor(options: LocalStorageKeyOptions | undefined) {
  return options?.scope === "backend" ? backendScopedIsomorphicStorage : isomorphicLocalStorage;
}

/** Key as it appears in `StorageEvent.key`; null while a bound window's identity is pending. */
function physicalKey(key: string, options: LocalStorageKeyOptions | undefined): string | null {
  return options?.scope === "backend" ? backendScopedKey(key) : key;
}

const decode = <T, E>(schema: Schema.Codec<T, E>, value: string) =>
  Schema.decodeSync(Schema.fromJsonString(schema))(value);

const encode = <T, E>(schema: Schema.Codec<T, E>, value: T) =>
  Schema.encodeSync(Schema.fromJsonString(schema))(value);

function readRawLocalStorageItem(
  storage: Pick<Storage, "getItem">,
  key: string,
  legacyKeys: ReadonlyArray<string>,
) {
  const item = storage.getItem(key);
  if (item !== null) {
    return { key, item } as const;
  }

  for (const legacyKey of legacyKeys) {
    const legacyItem = storage.getItem(legacyKey);
    if (legacyItem !== null) {
      return { key: legacyKey, item: legacyItem } as const;
    }
  }

  return null;
}

export const getLocalStorageItem = <T, E>(
  key: string,
  schema: Schema.Codec<T, E>,
  options?: LocalStorageOptions<T>,
): T | null => {
  const legacyKeys = options?.legacyKeys ?? [];
  const storage = storageFor(options);
  const resolved = readRawLocalStorageItem(storage, key, legacyKeys);
  if (!resolved) return null;

  const decoded = decode(schema, resolved.item);
  if (resolved.key !== key) {
    const migrated = options?.migrateLegacyValue ? options.migrateLegacyValue(decoded) : decoded;
    storage.setItem(key, options?.migrateLegacyValue ? encode(schema, migrated) : resolved.item);
    storage.removeItem(resolved.key);
    return migrated;
  }
  return decoded;
};

export const setLocalStorageItem = <T, E>(
  key: string,
  value: T,
  schema: Schema.Codec<T, E>,
  options?: LocalStorageOptions<T>,
) => {
  const valueToSet = encode(schema, value);
  const storage = storageFor(options);
  storage.setItem(key, valueToSet);
  for (const legacyKey of options?.legacyKeys ?? []) {
    storage.removeItem(legacyKey);
  }
};

export const removeLocalStorageItem = (key: string, options?: LocalStorageKeyOptions) => {
  const storage = storageFor(options);
  storage.removeItem(key);
  for (const legacyKey of options?.legacyKeys ?? []) {
    storage.removeItem(legacyKey);
  }
};

const LOCAL_STORAGE_CHANGE_EVENT = "bigbud:local_storage_change";

interface LocalStorageChangeDetail {
  key: string;
}

function dispatchLocalStorageChange(key: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<LocalStorageChangeDetail>(LOCAL_STORAGE_CHANGE_EVENT, {
      detail: { key },
    }),
  );
}

export function useLocalStorage<T, E>(
  key: string,
  initialValue: T,
  schema: Schema.Codec<T, E>,
  options?: LocalStorageOptions<T>,
): [T, (value: T | ((val: T) => T)) => void] {
  const legacyKeys = options?.legacyKeys;

  // Get the initial value from localStorage or use the provided initialValue
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = getLocalStorageItem(key, schema, options);
      return item ?? initialValue;
    } catch (error) {
      console.error("[LOCALSTORAGE] Error:", error);
      return initialValue;
    }
  });

  // Return a wrapped version of useState's setter function that persists the new value to localStorage
  const setValue = useCallback(
    (value: T | ((val: T) => T)) => {
      try {
        setStoredValue((prev) => {
          const valueToStore = typeof value === "function" ? (value as (val: T) => T)(prev) : value;
          if (valueToStore === null) {
            removeLocalStorageItem(key, options);
          } else {
            setLocalStorageItem(key, valueToStore, schema, options);
          }
          // Dispatch event after state update completes to avoid nested state updates
          queueMicrotask(() => dispatchLocalStorageChange(key));
          return valueToStore;
        });
      } catch (error) {
        console.error("[LOCALSTORAGE] Error:", error);
      }
    },
    [key, options, schema],
  );

  const prevKeyRef = useRef(key);

  // Re-sync from localStorage when key changes
  useEffect(() => {
    if (prevKeyRef.current !== key) {
      prevKeyRef.current = key;
      try {
        const newValue = getLocalStorageItem(key, schema, options);
        setStoredValue(newValue ?? initialValue);
      } catch (error) {
        console.error("[LOCALSTORAGE] Error:", error);
      }
    }
  }, [initialValue, key, options, schema]);

  // Listen for storage events from other tabs AND custom events from the same tab
  useEffect(() => {
    const syncFromStorage = () => {
      try {
        const newValue = getLocalStorageItem(key, schema, options);
        setStoredValue(newValue ?? initialValue);
      } catch (error) {
        console.error("[LOCALSTORAGE] Error:", error);
      }
    };

    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === null) return;
      const legacyMatch = legacyKeys?.some(
        (legacyKey) => physicalKey(legacyKey, options) === event.key,
      );
      if (event.key === physicalKey(key, options) || legacyMatch) {
        syncFromStorage();
      }
    };

    const handleLocalChange = (event: CustomEvent<LocalStorageChangeDetail>) => {
      if (event.detail.key === key) {
        syncFromStorage();
      }
    };

    window.addEventListener("storage", handleStorageChange);
    window.addEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalChange as EventListener);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalChange as EventListener);
    };
  }, [initialValue, key, legacyKeys, options, schema]);

  return [storedValue, setValue];
}
