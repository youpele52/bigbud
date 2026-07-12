import type { RefObject } from "react";
import type { BrowserResult } from "@bigbud/contracts";

import { executeBrowserTabActionWhenReady } from "./browserAgentControl";
import type { BrowserViewportRef } from "./BrowserPanel.viewport";

function matchesNavigationUrl(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  try {
    return new URL(actual).toString() === new URL(expected).toString();
  } catch {
    return actual === expected;
  }
}

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
    (result) => matchesNavigationUrl(result.page?.url, input.url),
  );
}
