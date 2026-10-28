import { describe, expect, it } from "vitest";

import { pickFrontmostWindow } from "./ComputerUse.desktop.target.ts";

const window = (id: number, zIndex: number | null) => ({
  pid: 100 + id,
  window_id: id,
  app_name: `App ${id}`,
  title: `Window ${id}`,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  is_on_screen: true,
  on_current_space: true,
  z_index: zIndex,
});

describe("pickFrontmostWindow", () => {
  it("picks the highest z_index when stacking is known (unchanged)", () => {
    expect(
      pickFrontmostWindow({ windows: [window(1, 3), window(2, 9), window(3, 5)] }),
    ).toMatchObject({ windowId: 2, zIndex: 9 });
  });

  it("refuses an ambiguous choice when stacking is unknown", () => {
    // Regression (lean M4): with z_index null the old code picked array order.
    expect(pickFrontmostWindow({ windows: [window(1, null), window(2, null)] })).toBeNull();
  });

  it("still picks a single candidate without stacking information", () => {
    expect(pickFrontmostWindow({ windows: [window(1, null)] })).toMatchObject({ windowId: 1 });
  });

  it("prefers a window with known stacking over unknown ones", () => {
    expect(pickFrontmostWindow({ windows: [window(1, null), window(2, 4)] })).toMatchObject({
      windowId: 2,
    });
  });

  it("refuses a z-order tie (unchanged)", () => {
    expect(pickFrontmostWindow({ windows: [window(1, 4), window(2, 4)] })).toBeNull();
  });
});
