import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useInyosiraStore } from "./inyosira.store";

const original = useInyosiraStore.getState();

beforeEach(() => useInyosiraStore.setState({ collapsedStates: [], expandedThreadLists: [] }));
afterEach(() => useInyosiraStore.setState(original));

describe("Inyosira thread preview expansion", () => {
  it("expands each thread list independently of other groups and their accordions", () => {
    const store = useInyosiraStore.getState();
    store.setThreadListExpanded("present", true);
    store.setThreadListExpanded("later", true);
    expect(useInyosiraStore.getState().expandedThreadLists).toEqual(["present", "later"]);
    expect(useInyosiraStore.getState().collapsedStates).toEqual([]);

    store.setStateCollapsed("present", true);
    expect(useInyosiraStore.getState().expandedThreadLists).toEqual(["present", "later"]);
    store.setStateCollapsed("present", false);
    store.setThreadListExpanded("present", false);
    expect(useInyosiraStore.getState().expandedThreadLists).toEqual(["later"]);
  });

  it("does not trigger subscribers for unchanged expansion", () => {
    const store = useInyosiraStore.getState();
    store.setThreadListExpanded("present", false);
    expect(useInyosiraStore.getState()).toBe(store);
    store.setThreadListExpanded("present", true);
    const expanded = useInyosiraStore.getState();
    store.setThreadListExpanded("present", true);
    expect(useInyosiraStore.getState()).toBe(expanded);
  });
});
