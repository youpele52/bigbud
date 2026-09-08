import type { WebContents } from "electron";

export interface BrowserNavigationPolicyOptions {
  readonly allowAboutBlank?: boolean;
}

interface NavigationEvent {
  preventDefault(): void;
}

/** Allows only top-level HTTP(S) browser navigations and the guest bootstrap page. */
export function isAllowedBrowserNavigation(
  url: string,
  options: BrowserNavigationPolicyOptions = {},
): boolean {
  if (options.allowAboutBlank && url === "about:blank") return true;

  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Binds the navigation policy to the top-level lifecycle of one browser guest. */
export function bindBrowserNavigationPolicy(guestWebContents: WebContents): void {
  const enforce = (event: NavigationEvent, url: string, isMainFrame: boolean): void => {
    if (!isMainFrame) return;

    if (
      !isAllowedBrowserNavigation(url, {
        allowAboutBlank: guestWebContents.getURL() === "",
      })
    ) {
      event.preventDefault();
    }
  };

  guestWebContents.on("will-navigate", (event, url, _isInPlace, isMainFrame) => {
    enforce(event as NavigationEvent, url, isMainFrame);
  });
  guestWebContents.on("will-redirect", (event, url, _isInPlace, isMainFrame) => {
    enforce(event as NavigationEvent, url, isMainFrame);
  });
}
