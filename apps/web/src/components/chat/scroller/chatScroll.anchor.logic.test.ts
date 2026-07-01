import { describe, expect, it } from "vitest";

import { resolveAnchorScrollTop } from "./chatScroll.anchor.logic";

describe("chatScroll anchor logic", () => {
  it("positions the anchor below the top margin and previous-item peek", () => {
    const scrollContainer = {
      scrollTop: 200,
      getBoundingClientRect: () => ({ top: 100 }),
    } as HTMLElement;
    const anchorElement = {
      getBoundingClientRect: () => ({ top: 420 }),
    } as HTMLElement;

    expect(
      resolveAnchorScrollTop(scrollContainer, anchorElement, {
        marginPx: 12,
        peekPx: 64,
      }),
    ).toBe(444);
  });
});
