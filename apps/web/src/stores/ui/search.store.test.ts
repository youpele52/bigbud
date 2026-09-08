import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSearchStore } from "./search.store";

describe("search.store", () => {
  beforeEach(() => {
    useSearchStore.setState({
      searchOpen: false,
      fileSearchContext: null,
      activeFileSearchContext: null,
    });
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

  it("opens with the focused file context as a snapshot", () => {
    const onSelectMatch = vi.fn();
    const context = { path: "src/app.ts", contents: "needle", onSelectMatch };

    useSearchStore.getState().setFileSearchContext(context);

    expect(useSearchStore.getState().openSearchForFileContext()).toBe(true);
    expect(useSearchStore.getState().searchOpen).toBe(true);
    expect(useSearchStore.getState().activeFileSearchContext).toBe(context);
  });

  it("does not open a file search without a focused preview", () => {
    expect(useSearchStore.getState().openSearchForFileContext()).toBe(false);
    expect(useSearchStore.getState().searchOpen).toBe(false);
  });

  it("clears the active file context when search closes", () => {
    const context = { path: "src/app.ts", contents: "needle", onSelectMatch: vi.fn() };
    useSearchStore.setState({ searchOpen: true, activeFileSearchContext: context });

    useSearchStore.getState().setSearchOpen(false);

    expect(useSearchStore.getState().activeFileSearchContext).toBeNull();
  });
});
