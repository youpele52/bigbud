import { session } from "electron";
import type { Session, WebContents } from "electron";

export const BROWSER_SESSION_PARTITION = "persist:bigbud-browser";
let browserSession: Session | undefined;

/** Creates the persistent session used exclusively by user-visible browser guests. */
export function initializeBrowserSession(): Session {
  if (browserSession) {
    return browserSession;
  }

  browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback, _details) => {
    callback(false);
  });
  browserSession.setPermissionCheckHandler(() => false);
  return browserSession;
}

/** Identifies guests created by the dedicated visible browser partition. */
export function isBrowserGuest(webContents: WebContents): boolean {
  return webContents.session === browserSession;
}
