import { dialog } from "electron";
import type { BrowserWindow, Session, WebContents } from "electron";
import { showBrowserFeedback } from "./browserFeedback";

const owners = new WeakMap<WebContents, BrowserWindow>();
const labels: Record<string, string> = {
  audio: "microphone",
  video: "camera",
  geolocation: "location",
  notifications: "notifications",
};

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** Registers only user-visible browser contents, never the privileged app renderer. */
export function registerBrowserPermissionOwner(owner: BrowserWindow, contents: WebContents): void {
  owners.set(contents, owner);
}

/** Installs deny-by-default, tab-and-origin-scoped consent for supported site permissions. */
export function installBrowserPermissions(session: Session): void {
  const decisions = new WeakMap<WebContents, Map<string, boolean>>();
  let promptActive = false;

  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const owner = owners.get(contents);
    if (!owner || owner.isDestroyed() || contents.isDestroyed() || contents.session !== session) {
      callback(false);
      return;
    }
    const origin = originOf(details.requestingUrl);
    const capabilities =
      permission === "media" && "mediaTypes" in details
        ? [...new Set(details.mediaTypes)].toSorted()
        : [permission];
    if (
      !origin ||
      !details.isMainFrame ||
      originOf(contents.getURL()) !== origin ||
      capabilities.length === 0 ||
      capabilities.some((capability) => !labels[capability])
    ) {
      callback(false);
      void showBrowserFeedback(
        owner,
        "A site permission was blocked by bigbud's security policy.",
        contents.getURL(),
      );
      return;
    }
    const saved = decisions.get(contents) ?? new Map<string, boolean>();
    decisions.set(contents, saved);
    const keys = capabilities.map((capability) => `${origin}:${capability}`);
    if (keys.some((key) => saved.has(key) && !saved.get(key))) {
      callback(false);
      return;
    }
    if (keys.every((key) => saved.get(key))) {
      callback(true);
      return;
    }
    if (promptActive) {
      callback(false);
      return;
    }
    promptActive = true;
    const controller = new AbortController();
    let settled = false;
    const finish = (allow: boolean, remember = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      contents.removeListener("destroyed", cancel);
      contents.removeListener("did-start-navigation", cancelNavigation);
      owner.removeListener("closed", cancel);
      controller.abort();
      promptActive = false;
      if (remember) {
        if (saved.size > 64) saved.clear();
        for (const key of keys) saved.set(key, allow);
      }
      callback(allow);
    };
    const cancel = (): void => finish(false);
    const cancelNavigation = (
      _event: unknown,
      _url: string,
      inPlace: boolean,
      mainFrame: boolean,
    ): void => {
      if (mainFrame && !inPlace) cancel();
    };
    const timeout = setTimeout(cancel, 60_000);
    contents.once("destroyed", cancel);
    contents.on("did-start-navigation", cancelNavigation);
    owner.once("closed", cancel);
    void dialog
      .showMessageBox(owner, {
        type: "question",
        title: "bigbud browser permission",
        message: `Allow ${origin} to access ${capabilities.map((capability) => labels[capability]).join(" and ")}?`,
        detail:
          "This decision applies only to this site's browser tab until it closes. Your operating system may also ask for permission. Unsupported permissions remain blocked.",
        buttons: ["Deny", "Allow for this tab"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        signal: controller.signal,
      })
      .then(({ response }) => {
        const valid =
          !contents.isDestroyed() && !owner.isDestroyed() && originOf(contents.getURL()) === origin;
        finish(valid && response === 1, valid);
      })
      .catch(() => finish(false));
  });

  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (!contents || !details.isMainFrame) return false;
    const owner = owners.get(contents);
    if (!owner || owner.isDestroyed() || contents.isDestroyed() || contents.session !== session)
      return false;
    const origin = originOf(requestingOrigin);
    if (!origin || originOf(contents.getURL()) !== origin) return false;
    const capability = permission === "media" ? details.mediaType : permission;
    return Boolean(
      capability && labels[capability] && decisions.get(contents)?.get(`${origin}:${capability}`),
    );
  });
}
