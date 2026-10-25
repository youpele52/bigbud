import type { PersistStorage, StorageValue } from "zustand/middleware";

function sameTopLevelSlices(previous: object, next: object): boolean {
  const previousEntries = Object.entries(previous);
  if (previousEntries.length !== Object.keys(next).length) return false;
  return previousEntries.every(
    ([key, value]) =>
      Object.hasOwn(next, key) && Object.is(value, (next as Record<string, unknown>)[key]),
  );
}

/**
 * zustand's persist middleware serializes on every `set`, even when the partialized slices are
 * unchanged. Hot stores (terminal output batches) must not pay JSON.stringify + a synchronous
 * localStorage write per event. Skips a write when every persisted top-level slice is
 * reference-equal to the last successful write; immutable updates make that check exact.
 */
export function skipUnchangedPersistWrites<S>(
  storage: PersistStorage<S> | undefined,
): PersistStorage<S> | undefined {
  if (!storage) return storage;
  let lastWritten: StorageValue<S> | null = null;
  return {
    getItem: (name) => {
      lastWritten = null;
      return storage.getItem(name);
    },
    setItem: (name, value) => {
      if (
        lastWritten !== null &&
        lastWritten.version === value.version &&
        typeof value.state === "object" &&
        value.state !== null &&
        sameTopLevelSlices(lastWritten.state as object, value.state)
      )
        return;
      const result = storage.setItem(name, value);
      lastWritten = value;
      return result;
    },
    removeItem: (name) => {
      lastWritten = null;
      return storage.removeItem(name);
    },
  };
}
