import { dialog, shell } from "electron";
import type { BrowserWindow } from "electron";
import { isAllowedBrowserNavigation } from "./browserNavigationPolicy";

const pendingOwners = new WeakSet<BrowserWindow>();
const lastShown = new WeakMap<BrowserWindow, number>();

/** Shows bounded native feedback; remote pages can never launch an external app directly. */
export async function showBrowserFeedback(
  owner: BrowserWindow,
  message: string,
  url: string,
  userInitiated = false,
): Promise<void> {
  if (
    owner.isDestroyed() ||
    pendingOwners.has(owner) ||
    (!userInitiated && Date.now() - (lastShown.get(owner) ?? 0) < 10_000)
  )
    return;
  lastShown.set(owner, Date.now());
  pendingOwners.add(owner);
  const externalUrl = isAllowedBrowserNavigation(url) ? url : null;
  try {
    const { response } = await dialog.showMessageBox(owner, {
      type: "warning",
      title: "bigbud browser",
      message,
      detail:
        `${externalUrl ? `Site: ${new URL(externalUrl).origin}\n\n` : ""}` +
        "Some sites and sign-in providers require a full browser. Opening externally starts a separate browser session; bigbud does not transfer cookies or sign-in state.",
      buttons: externalUrl ? ["Close", "Open in default browser"] : ["Close"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 1 && externalUrl && !owner.isDestroyed()) {
      await shell.openExternal(externalUrl);
    }
  } catch (error) {
    console.warn("[browser] Could not show feedback or open the default browser", error);
  } finally {
    pendingOwners.delete(owner);
  }
}
