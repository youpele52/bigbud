import { Menu } from "electron";
import type { BrowserWindow, WebContents, WebPreferences } from "electron";
import { bindBrowserNavigationPolicy, isAllowedBrowserNavigation } from "./browserNavigationPolicy";
import { hardenBrowserGuestPreferences } from "./browserGuestPreferences";
import { registerBrowserPermissionOwner } from "./browserPermissions";
import { showBrowserFeedback } from "./browserFeedback";
import { bindBrowserHistoryGestures } from "./browserHistoryGestures";

/** Keeps real opener/session semantics while bounding and isolating remote popup windows. */
export function bindBrowserPopups(owner: BrowserWindow, root: WebContents): void {
  const children = new Set<BrowserWindow>();
  const feedback = (message: string, url = root.isDestroyed() ? "" : root.getURL()): void => {
    void showBrowserFeedback(owner, message, url);
  };
  const bind = (contents: WebContents, gestureOwner = owner): void => {
    bindBrowserHistoryGestures(gestureOwner, contents);
    registerBrowserPermissionOwner(owner, contents);
    bindBrowserNavigationPolicy(contents, () =>
      feedback(
        "This navigation was blocked. Only HTTP and HTTPS pages are supported.",
        contents.getURL(),
      ),
    );
    contents.setWindowOpenHandler(({ url }) => {
      if (!isAllowedBrowserNavigation(url, { allowAboutBlank: true }) || children.size >= 3) {
        feedback(
          children.size >= 3
            ? "Popup limit reached. Close an existing browser popup and try again."
            : "This popup was blocked. Only HTTP and HTTPS pages are supported.",
          contents.getURL(),
        );
        return { action: "deny" };
      }
      const webPreferences: WebPreferences = { session: root.session };
      hardenBrowserGuestPreferences(webPreferences);
      return {
        action: "allow",
        outlivesOpener: false,
        overrideBrowserWindowOptions: {
          parent: owner,
          width: 640,
          height: 760,
          minWidth: 360,
          minHeight: 320,
          title: "bigbud browser popup",
          autoHideMenuBar: true,
          fullscreenable: false,
          webPreferences,
        },
      };
    });
    contents.on("did-create-window", (popup) => {
      children.add(popup);
      const guest = popup.webContents;
      // Host certificate challenges are tab-only. Popups fail normal certificate
      // validation immediately and offer the external fallback via did-fail-load.
      bind(guest, popup);
      popup.setMenu(null);
      guest.on("context-menu", () => {
        Menu.buildFromTemplate([
          {
            label: "Open in default browser",
            click: () => {
              void showBrowserFeedback(
                owner,
                "Open this popup in your default browser?",
                guest.getURL(),
                true,
              );
            },
          },
          { label: "Reload", click: () => guest.reload() },
          { type: "separator" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
          { type: "separator" },
          { label: "Close popup", click: () => popup.close() },
        ]).popup({ window: popup });
      });
      const updateTitle = (): void => {
        if (popup.isDestroyed() || guest.isDestroyed()) return;
        let origin = "about:blank";
        try {
          origin = new URL(guest.getURL()).origin;
        } catch {
          /* Initial blank popup. */
        }
        popup.setTitle(`bigbud browser — ${origin}`);
      };
      popup.on("page-title-updated", (event) => {
        event.preventDefault();
        updateTitle();
      });
      guest.on("did-navigate", updateTitle);
      guest.on("did-fail-load", (_event, code, description, url, mainFrame) => {
        if (mainFrame && code !== -3)
          feedback(`The browser popup could not load (${description}).`, url);
      });
      guest.on("render-process-gone", () =>
        feedback("The browser popup stopped responding. Close it and try again.", guest.getURL()),
      );
      popup.once("closed", () => children.delete(popup));
      updateTitle();
    });
  };
  bind(root);
  const closeChildren = (): void => {
    for (const popup of children) if (!popup.isDestroyed()) popup.destroy();
    children.clear();
  };
  root.once("destroyed", closeChildren);
  owner.once("closed", closeChildren);
  root.once("destroyed", () => owner.removeListener("closed", closeChildren));
}
