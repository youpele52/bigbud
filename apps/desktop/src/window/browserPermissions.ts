import { dialog } from "electron";
import type { BrowserWindow, Session, WebContents } from "electron";
import { showBrowserFeedback } from "./browserFeedback";

const PROMPT_TIMEOUT_MS = 60_000;
const MAX_REMEMBERED_DECISIONS = 256;
const owners = new WeakMap<WebContents, { owner: BrowserWindow; tab: WebContents }>();
const requests: Record<string, string> = {
  audio: "use your microphone",
  video: "use your camera",
  geolocation: "know your location",
  notifications: "show notifications",
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
export function registerBrowserPermissionOwner(
  owner: BrowserWindow,
  contents: WebContents,
  tab: WebContents = contents,
): void {
  owners.set(contents, { owner, tab });
}

/**
 * Installs deny-by-default consent: each feature is asked for separately, and every
 * answer is kept per site and feature in memory only, until bigbud quits.
 */
export function installBrowserPermissions(session: Session): void {
  const decisions = new Map<string, boolean>();
  let promptActive = false;
  const remember = (key: string, allow: boolean): void => {
    decisions.delete(key);
    if (decisions.size >= MAX_REMEMBERED_DECISIONS) {
      const oldest = decisions.keys().next().value;
      if (oldest !== undefined) decisions.delete(oldest);
    }
    decisions.set(key, allow);
  };

  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const { owner, tab } = owners.get(contents) ?? {};
    if (
      !owner ||
      !tab ||
      owner.isDestroyed() ||
      contents.isDestroyed() ||
      contents.session !== session
    ) {
      callback(false);
      return;
    }
    const origin = originOf(details.requestingUrl);
    const capabilities =
      permission === "media" && "mediaTypes" in details
        ? [...new Set(details.mediaTypes)].toSorted()
        : [permission];
    const supported =
      capabilities.length > 0 && capabilities.every((capability) => requests[capability]);
    if (!supported || !origin || !details.isMainFrame || originOf(contents.getURL()) !== origin) {
      callback(false);
      // Unsupported permissions (fullscreen, clipboard, storage access, ...) stay quiet;
      // only explain requests a tab could otherwise have granted.
      if (supported)
        void showBrowserFeedback(
          owner,
          "Only the page itself can ask for camera, microphone, location or notifications. Requests from embedded content or other sites are blocked.",
          contents.getURL(),
          tab,
        );
      return;
    }
    const keyOf = (capability: string) => `${origin}:${capability}`;
    if (capabilities.some((capability) => decisions.get(keyOf(capability)) === false)) {
      callback(false);
      return;
    }
    const undecided = capabilities.filter((capability) => !decisions.get(keyOf(capability)));
    if (undecided.length === 0) {
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
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (allow: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      contents.removeListener("destroyed", cancel);
      contents.removeListener("did-start-navigation", cancelNavigation);
      owner.removeListener("closed", cancel);
      controller.abort();
      promptActive = false;
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
    contents.once("destroyed", cancel);
    contents.on("did-start-navigation", cancelNavigation);
    owner.once("closed", cancel);
    // One prompt per feature; the first denial ends the request.
    const askEach = async (): Promise<boolean> => {
      for (const capability of undecided) {
        clearTimeout(timeout);
        timeout = setTimeout(cancel, PROMPT_TIMEOUT_MS);
        const { response } = await dialog.showMessageBox(owner, {
          type: "question",
          title: "bigbud browser permission",
          message: `Allow ${origin} to ${requests[capability]}?`,
          detail:
            "bigbud remembers your choice for this site until you quit bigbud. Your operating system may also ask for permission.",
          buttons: ["Deny", "Allow"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          signal: controller.signal,
        });
        if (
          settled ||
          contents.isDestroyed() ||
          owner.isDestroyed() ||
          originOf(contents.getURL()) !== origin
        )
          return false;
        remember(keyOf(capability), response === 1);
        if (response !== 1) return false;
      }
      return true;
    };
    void askEach().then(finish, cancel);
  });

  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (!contents || !details.isMainFrame) return false;
    const owner = owners.get(contents)?.owner;
    if (!owner || owner.isDestroyed() || contents.isDestroyed() || contents.session !== session)
      return false;
    const origin = originOf(requestingOrigin);
    if (!origin || originOf(contents.getURL()) !== origin) return false;
    const capability = permission === "media" ? details.mediaType : permission;
    return Boolean(capability && requests[capability] && decisions.get(`${origin}:${capability}`));
  });
}
