export type RightPanelKind = "browser" | "diff" | "files" | "terminal";

let requestedRightPanel: RightPanelKind | null = null;
let closeDiffPanel: (() => void) | null = null;

export function requestRightPanel(panel: RightPanelKind | null) {
  requestedRightPanel = panel;
}

export function getRequestedRightPanel(): RightPanelKind | null {
  return requestedRightPanel;
}

export function registerDiffPanelCloseAction(callback: (() => void) | null) {
  closeDiffPanel = callback;

  return () => {
    if (closeDiffPanel === callback) {
      closeDiffPanel = null;
    }
  };
}

export function closeDiffPanelIfOpen() {
  closeDiffPanel?.();
}
