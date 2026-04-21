import { describe, expect, it } from "vitest";

import { useCommandPaletteStore } from "./commandPalette.store";

describe("commandPalette.store", () => {
  it("toggles open state", () => {
    useCommandPaletteStore.setState({ open: false });
    useCommandPaletteStore.getState().toggleOpen();
    expect(useCommandPaletteStore.getState().open).toBe(true);
    useCommandPaletteStore.getState().setOpen(false);
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });
});
