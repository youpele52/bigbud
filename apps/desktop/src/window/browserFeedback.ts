import { dialog, shell } from "electron";
import type { BrowserWindow, WebContents } from "electron";
import { isAllowedBrowserNavigation } from "./browserNavigationPolicy";

const PAGE_FEEDBACK_INTERVAL_MS = 10_000;
const PAGE_FEEDBACK_PER_TAB = 3;
const pendingOwners = new WeakSet<BrowserWindow>();
const lastShown = new WeakMap<BrowserWindow, number>();
const pageFeedback = new WeakMap<WebContents, Set<string>>();

/** Who caused the feedback: the browser tab whose page triggered it, or the user. */
export type BrowserFeedbackTrigger = WebContents | "user";

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** Pages must not be able to keep the app window behind repeated modal dialogs. */
function admitPageFeedback(
  owner: BrowserWindow,
  tab: WebContents,
  message: string,
  url: string,
): boolean {
  if (Date.now() - (lastShown.get(owner) ?? 0) < PAGE_FEEDBACK_INTERVAL_MS) return false;
  const shown = pageFeedback.get(tab) ?? new Set<string>();
  const key = `${originOf(url)}\n${message}`;
  if (shown.has(key) || shown.size >= PAGE_FEEDBACK_PER_TAB) return false;
  shown.add(key);
  pageFeedback.set(tab, shown);
  return true;
}

/** Shows bounded native feedback; remote pages can never launch an external app directly. */
export async function showBrowserFeedback(
  owner: BrowserWindow,
  message: string,
  url: string,
  trigger: BrowserFeedbackTrigger,
): Promise<void> {
  if (
    owner.isDestroyed() ||
    pendingOwners.has(owner) ||
    (trigger !== "user" && !admitPageFeedback(owner, trigger, message, url))
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
