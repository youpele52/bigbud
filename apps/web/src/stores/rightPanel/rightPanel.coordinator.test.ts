import { afterEach, describe, expect, it } from "vitest";

import {
  closeDiffPanelIfOpen,
  getRequestedRightPanel,
  registerDiffPanelCloseAction,
  requestRightPanel,
} from "./rightPanel.coordinator";

describe("rightPanel.coordinator", () => {
  afterEach(() => {
    registerDiffPanelCloseAction(null);
    requestRightPanel(null);
  });

  it("tracks the currently requested right panel", () => {
    expect(getRequestedRightPanel()).toBeNull();

    requestRightPanel("browser");
    expect(getRequestedRightPanel()).toBe("browser");

    requestRightPanel("files");
    expect(getRequestedRightPanel()).toBe("files");

    requestRightPanel("diff");
    expect(getRequestedRightPanel()).toBe("diff");

    requestRightPanel(null);
    expect(getRequestedRightPanel()).toBeNull();
  });

  it("invokes the registered diff close action", () => {
    let invoked = 0;
    const dispose = registerDiffPanelCloseAction(() => {
      invoked += 1;
    });

    closeDiffPanelIfOpen();
    expect(invoked).toBe(1);

    closeDiffPanelIfOpen();
    expect(invoked).toBe(2);

    dispose();
    closeDiffPanelIfOpen();
    expect(invoked).toBe(2);
  });

  it("ignores a null diff close action", () => {
    expect(() => closeDiffPanelIfOpen()).not.toThrow();
  });
});
