import { openBrowserPanel } from "../../stores/browser/browserPanel.actions";
import { isTerminalLinkActivation } from "../../utils/terminal/links.utils";

/** Return whether a terminal hyperlink is a valid HTTP(S) URL. */
export function isTerminalWebUrl(value: string): boolean {
  try {
    const protocol = new URL(value.trim()).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Open a terminal HTTP(S) hyperlink in bigbud's validated browser panel path. */
export function openTerminalWebLink(value: string): boolean {
  const url = value.trim();
  if (!isTerminalWebUrl(url)) {
    return false;
  }

  openBrowserPanel({ url });
  return true;
}

/** Handle xterm OSC 8 links without falling back to xterm's confirm/window.open path. */
export function createTerminalWebLinkHandler() {
  return {
    allowNonHttpProtocols: false,
    activate: (event: MouseEvent, text: string) => {
      if (!isTerminalLinkActivation(event)) {
        return;
      }

      openTerminalWebLink(text);
    },
  };
}
