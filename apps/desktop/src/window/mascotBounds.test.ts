import { describe, expect, it } from "vitest";

import { clampBounds, compactChatBounds, COMPACT_CHAT_SIZE } from "./mascotBounds";

describe("mascot bounds", () => {
  const workArea = { x: -1280, y: 0, width: 1280, height: 720 };

  it("clamps oversized and off-screen bounds into a negative-coordinate display", () => {
    expect(clampBounds({ x: 300, y: -50, width: 2000, height: 900 }, workArea)).toEqual({
      x: -1280,
      y: 0,
      width: 1280,
      height: 720,
    });
  });

  it("places compact chat adjacent to the mascot and fully within the work area", () => {
    const bounds = compactChatBounds({ x: -64, y: 656, width: 64, height: 64 }, workArea);
    expect(bounds.width).toBe(COMPACT_CHAT_SIZE.width);
    expect(bounds.height).toBeLessThanOrEqual(COMPACT_CHAT_SIZE.height);
    expect(bounds.x).toBeGreaterThanOrEqual(workArea.x);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(workArea.y + workArea.height);
  });
});
