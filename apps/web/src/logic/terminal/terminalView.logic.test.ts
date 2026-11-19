import { describe, expect, it } from "vitest";
import { visibleTerminalIds } from "./terminalView.logic";

const layout = (terminalOpen: boolean) => ({
  terminalOpen,
  activeTerminalGroupId: "g2",
  terminalGroups: [
    { id: "g1", terminalIds: ["a"] },
    { id: "g2", terminalIds: ["b", "c"] },
  ],
});

describe("visibleTerminalIds", () => {
  it("reports the active split group of an open drawer or panel only", () => {
    expect(
      visibleTerminalIds({ drawer: layout(true), panel: undefined, panelOpen: false }),
    ).toEqual(["b", "c"]);
    expect(
      visibleTerminalIds({ drawer: layout(false), panel: undefined, panelOpen: false }),
    ).toEqual([]);
    expect(
      visibleTerminalIds({ drawer: undefined, panel: layout(false), panelOpen: true }),
    ).toEqual(["b", "c"]);
  });
});
