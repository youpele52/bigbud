import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSearchStore } from "./search.store";

describe("search.store", () => {
  beforeEach(() => {
    useSearchStore.setState({ searchOpen: false });
  });

  it("initializes with search closed", () => {
    expect(useSearchStore.getState().searchOpen).toBe(false);
  });

  it("toggles open state from false to true", () => {
    useSearchStore.getState().toggleSearchOpen();
    expect(useSearchStore.getState().searchOpen).toBe(true);
  });

  it("toggles open state from true to false", () => {
    useSearchStore.setState({ searchOpen: true });
    useSearchStore.getState().toggleSearchOpen();
    expect(useSearchStore.getState().searchOpen).toBe(false);
  });

  it("sets open state to true", () => {
    useSearchStore.getState().setSearchOpen(true);
    expect(useSearchStore.getState().searchOpen).toBe(true);
  });

  it("sets open state to false", () => {
    useSearchStore.setState({ searchOpen: true });
    useSearchStore.getState().setSearchOpen(false);
    expect(useSearchStore.getState().searchOpen).toBe(false);
  });

  it("does not update state when setting same value", () => {
    const state = useSearchStore.getState();
    const setSpy = vi.spyOn(useSearchStore, "setState");

    state.setSearchOpen(false);

    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });
});
