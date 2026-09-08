import { describe, expect, it, vi } from "vitest";

import type { ElectronWebview } from "./BrowserPanel.viewport.types";
import {
  assignBrowserWebviewPartition,
  BROWSER_WEBVIEW_PARTITION,
} from "./BrowserPanel.viewport.webview.partition";

describe("browser webview partition", () => {
  it("assigns the shared persistent browser partition before navigation", () => {
    const setAttribute = vi.fn();

    assignBrowserWebviewPartition({ setAttribute } as unknown as ElectronWebview);

    expect(setAttribute).toHaveBeenCalledWith("partition", BROWSER_WEBVIEW_PARTITION);
  });
});
