import { useState } from "react";

/** Offers a user-initiated HTTP(S) fallback without sharing embedded browser state. */
export function BrowserExternalLink({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  try {
    if (!["http:", "https:"].includes(new URL(url).protocol)) return null;
  } catch {
    return null;
  }
  return (
    <span>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm underline underline-offset-4"
        onClick={(event) => {
          const bridge = window.desktopBridge;
          if (!bridge) return;
          event.preventDefault();
          setFailed(false);
          // The desktop bridge reports refusals as `false`, not as rejections.
          void bridge.openExternal(url).then(
            (opened) => setFailed(!opened),
            () => setFailed(true),
          );
        }}
      >
        Open in default browser
      </a>
      {failed && (
        <span role="alert" className="ml-2 text-xs text-destructive">
          Could not open the browser. Copy the address and open it manually.
        </span>
      )}
    </span>
  );
}
