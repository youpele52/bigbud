import { describe, expect, it } from "vitest";

import {
  chunkScrollAmount,
  MACOS_SCROLL_CHUNK_MAX,
  normalizeScroll,
  scrollDeliveryCounts,
} from "./scroll";

describe("normalizeScroll", () => {
  it("refuses an all-zero or omitted delta", () => {
    expect(normalizeScroll(undefined, undefined)).toBeNull();
    expect(normalizeScroll(0, 0)).toBeNull();
    expect(normalizeScroll(-0, undefined)).toBeNull();
  });

  it("chooses the dominant axis with vertical winning ties and ignores the minor axis", () => {
    expect(normalizeScroll(3, 3)).toEqual({ direction: "down", amount: 3 });
    expect(normalizeScroll(-3, -3)).toEqual({ direction: "up", amount: 3 });
    expect(normalizeScroll(-9, 2)).toEqual({ direction: "left", amount: 9 });
    expect(normalizeScroll(9, undefined)).toEqual({ direction: "right", amount: 9 });
    expect(normalizeScroll(undefined, -4)).toEqual({ direction: "up", amount: 4 });
  });

  it("rounds and clamps the dominant magnitude to 1-100", () => {
    expect(normalizeScroll(0, 0.2)).toEqual({ direction: "down", amount: 1 });
    expect(normalizeScroll(0, 2.5)).toEqual({ direction: "down", amount: 3 });
    expect(normalizeScroll(0, -1e9)).toEqual({ direction: "up", amount: 100 });
  });
});

describe("chunkScrollAmount", () => {
  it("splits into macOS-sized chunks that sum to the normalized total", () => {
    expect(chunkScrollAmount(100, MACOS_SCROLL_CHUNK_MAX)).toEqual([50, 50]);
    expect(chunkScrollAmount(73, MACOS_SCROLL_CHUNK_MAX)).toEqual([50, 23]);
    expect(chunkScrollAmount(50, MACOS_SCROLL_CHUNK_MAX)).toEqual([50]);
    expect(chunkScrollAmount(1, MACOS_SCROLL_CHUNK_MAX)).toEqual([1]);
    for (let amount = 1; amount <= 100; amount += 1) {
      const chunks = chunkScrollAmount(amount, MACOS_SCROLL_CHUNK_MAX);
      expect(chunks.reduce((sum, value) => sum + value, 0)).toBe(amount);
      expect(chunks.every((value) => value >= 1 && value <= MACOS_SCROLL_CHUNK_MAX)).toBe(true);
    }
  });

  it("refuses unnormalized input instead of inventing units", () => {
    for (const [amount, max] of [
      [0, 50],
      [101, 50],
      [2.5, 50],
      [10, 0],
      [10, 1.5],
    ] as const) {
      expect(() => chunkScrollAmount(amount, max)).toThrow(RangeError);
    }
  });

  it("reports the delivered prefix of a partially delivered chunked scroll", () => {
    const chunks = chunkScrollAmount(73, MACOS_SCROLL_CHUNK_MAX);
    expect(scrollDeliveryCounts(chunks, 0)).toEqual({ delivered: 0, requested: 73 });
    expect(scrollDeliveryCounts(chunks, 1)).toEqual({ delivered: 50, requested: 73 });
    expect(scrollDeliveryCounts(chunks, 9)).toEqual({ delivered: 73, requested: 73 });
  });
});
