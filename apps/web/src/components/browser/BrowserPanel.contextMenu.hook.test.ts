import { describe, expect, it } from "vitest";

import { toggleCenteredBrowserContextMenuAnchor } from "./BrowserPanel.contextMenu.hook";

describe("toggleCenteredBrowserContextMenuAnchor", () => {
  it("opens a closed menu and closes an open menu", () => {
    const open = toggleCenteredBrowserContextMenuAnchor(null);

    expect(open).toEqual({ kind: "center" });
    expect(toggleCenteredBrowserContextMenuAnchor(open)).toBeNull();
  });
});
