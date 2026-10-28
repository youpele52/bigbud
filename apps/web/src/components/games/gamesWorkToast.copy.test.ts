import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GAMES_WORK_TOAST_LAST_MESSAGE_KEY,
  GAMES_WORK_TOAST_MESSAGES,
} from "~/constants/gamesWorkToast";
import { createGamesWorkToastPicker } from "./gamesWorkToast.copy";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next;
    }),
  };
}

afterEach(() => vi.restoreAllMocks());

function expectCompleteBag(messages: unknown[]) {
  expect(messages).toHaveLength(10);
  expect(new Set(messages)).toEqual(new Set(GAMES_WORK_TOAST_MESSAGES));
}

describe("games toast shuffled bag", () => {
  it("keeps ten distinct title/message pairs", () => {
    expect(GAMES_WORK_TOAST_MESSAGES).toHaveLength(10);
    expect(new Set(GAMES_WORK_TOAST_MESSAGES.map((copy) => copy.title)).size).toBe(10);
    expect(new Set(GAMES_WORK_TOAST_MESSAGES.map((copy) => copy.description)).size).toBe(10);
  });

  it.each([0, 0.25, 0.5, 0.999999])(
    "shows every message once per bag, including across boundaries (random %s)",
    (random) => {
      vi.spyOn(Math, "random").mockReturnValue(random);
      const pick = createGamesWorkToastPicker();
      const storage = memoryStorage();
      let previous: (typeof GAMES_WORK_TOAST_MESSAGES)[number] | undefined;
      for (let round = 0; round < 10; round++) {
        const messages = [];
        for (let index = 0; index < 10; index++) {
          const next = pick(storage);
          expect(next).not.toEqual(previous);
          messages.push(next);
          previous = next;
        }
        expectCompleteBag(messages);
      }
    },
  );

  it("swaps the first entry when a reshuffle would repeat the previous message", () => {
    // With zero-valued draws, Fisher–Yates puts message 1 first.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const storage = memoryStorage(JSON.stringify({ previousIndex: 1, remaining: [] }));
    const pick = createGamesWorkToastPicker();
    const messages = Array.from({ length: 10 }, () => pick(storage));
    expect(messages[0]).not.toEqual(GAMES_WORK_TOAST_MESSAGES[1]);
    expectCompleteBag(messages);
  });

  it("uses randomness to change the bag order", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const first = createGamesWorkToastPicker()(memoryStorage());
    random.mockReturnValue(0.999999);
    expect(createGamesWorkToastPicker()(memoryStorage())).not.toEqual(first);
  });

  it("persists the remaining bag through recreation, including the reshuffle boundary", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const storage = memoryStorage();
    let previous: (typeof GAMES_WORK_TOAST_MESSAGES)[number] | undefined;
    for (let round = 0; round < 3; round++) {
      const messages = [];
      for (let index = 0; index < 10; index++) {
        const next = createGamesWorkToastPicker()(storage);
        expect(next).not.toEqual(previous);
        messages.push(next);
        previous = next;
      }
      expectCompleteBag(messages);
    }
    expect(storage.setItem).toHaveBeenLastCalledWith(
      GAMES_WORK_TOAST_LAST_MESSAGE_KEY,
      expect.any(String),
    );
  });

  it.each(GAMES_WORK_TOAST_MESSAGES.map((_, index) => index))(
    "migrates legacy index %i without repeating it",
    (index) => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const pick = createGamesWorkToastPicker();
      const storage = memoryStorage(String(index));
      const messages = Array.from({ length: 10 }, () => pick(storage));
      expect(messages[0]).not.toEqual(GAMES_WORK_TOAST_MESSAGES[index]);
      expectCompleteBag(messages);
    },
  );

  it.each([
    "broken",
    "-1",
    "10",
    "1.5",
    "null",
    "[]",
    "{}",
    '{"previousIndex":0,"remaining":[1,1]}',
    '{"previousIndex":0,"remaining":[0,1]}',
    '{"previousIndex":0,"remaining":[10]}',
    '{"previousIndex":0,"remaining":[1.5]}',
    '{"previousIndex":0,"remaining":["1"]}',
    '{"previousIndex":null,"remaining":[1]}',
  ])("starts a complete bag for invalid saved data %s", (value) => {
    const pick = createGamesWorkToastPicker();
    const storage = memoryStorage(value);
    expectCompleteBag(Array.from({ length: 10 }, () => pick(storage)));
  });

  it.each([true, false])("retains the bag when writes fail (reads also fail: %s)", (failReads) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const storage = memoryStorage("9");
    if (failReads)
      storage.getItem.mockImplementation(() => {
        throw new Error("unavailable");
      });
    storage.setItem.mockImplementation(() => {
      throw new Error("full");
    });
    const pick = createGamesWorkToastPicker();
    let previous: (typeof GAMES_WORK_TOAST_MESSAGES)[number] | undefined;
    for (let round = 0; round < 3; round++) {
      const messages = Array.from({ length: 10 }, () => {
        const next = pick(storage);
        expect(next).not.toEqual(previous);
        previous = next;
        return next;
      });
      expectCompleteBag(messages);
    }
  });
});
