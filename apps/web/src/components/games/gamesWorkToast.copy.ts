import {
  GAMES_WORK_TOAST_LAST_MESSAGE_KEY,
  GAMES_WORK_TOAST_MESSAGES,
} from "~/constants/gamesWorkToast";

type CopyStorage = Pick<Storage, "getItem" | "setItem">;
type BagState = { previousIndex: number | null; remaining: number[] };

function isMessageIndex(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < GAMES_WORK_TOAST_MESSAGES.length
  );
}

function readBag(storage: CopyStorage): BagState {
  const fresh: BagState = { previousIndex: null, remaining: [] };
  try {
    const value: unknown = JSON.parse(storage.getItem(GAMES_WORK_TOAST_LAST_MESSAGE_KEY) ?? "null");
    // Migrate the original last-index-only format without repeating that message.
    if (isMessageIndex(value)) return { previousIndex: value, remaining: [] };
    if (value === null || typeof value !== "object") return fresh;
    const state = value as Partial<BagState>;
    if (
      isMessageIndex(state.previousIndex) &&
      Array.isArray(state.remaining) &&
      state.remaining.every(isMessageIndex) &&
      new Set(state.remaining).size === state.remaining.length &&
      !state.remaining.includes(state.previousIndex)
    ) {
      return { previousIndex: state.previousIndex, remaining: state.remaining };
    }
  } catch {
    // Start fresh when storage cannot be read or contains malformed data.
  }
  return fresh;
}

function shuffledBag(previousIndex: number | null): number[] {
  const bag = GAMES_WORK_TOAST_MESSAGES.map((_, index) => index);
  for (let index = bag.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [bag[index], bag[other]] = [bag[other]!, bag[index]!];
  }
  if (bag[0] === previousIndex) {
    const other = 1 + Math.floor(Math.random() * (bag.length - 1));
    [bag[0], bag[other]] = [bag[other]!, bag[0]!];
  }
  return bag;
}

/** Keeps the current bag in memory if persistence is unavailable. */
export function createGamesWorkToastPicker() {
  let state: BagState | undefined;
  return (storage: CopyStorage) => {
    state ??= readBag(storage);
    if (state.remaining.length === 0) state.remaining = shuffledBag(state.previousIndex);
    const index = state.remaining.shift()!;
    state.previousIndex = index;
    try {
      storage.setItem(GAMES_WORK_TOAST_LAST_MESSAGE_KEY, JSON.stringify(state));
    } catch {
      // The in-memory bag still advances when storage is full or unavailable.
    }
    return GAMES_WORK_TOAST_MESSAGES[index]!;
  };
}
