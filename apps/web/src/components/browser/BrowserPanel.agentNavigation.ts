import type { RefObject } from "react";
import type { BrowserResult } from "@bigbud/contracts";

import { matchesBrowserUrl } from "~/lib/browserUrl";
import { executeBrowserTabActionWhenReady } from "./browserAgentControl";
import type { BrowserViewportRef } from "./BrowserPanel.viewport";

export async function waitForVisibleBrowserNavigation(input: {
  readonly url: string;
  readonly viewportRef: RefObject<BrowserViewportRef | null>;
}): Promise<BrowserResult> {
  return executeBrowserTabActionWhenReady(
    () => {
      const viewport = input.viewportRef.current;
      if (!viewport) {
        throw new Error("The visible browser tab is not ready.");
      }
      return viewport.executeAgentAction({ action: "get_page_info" });
    },
    (result) => matchesBrowserUrl(result.page?.url, input.url),
  );
}
