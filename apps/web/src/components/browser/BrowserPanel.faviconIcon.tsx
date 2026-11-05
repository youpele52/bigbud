import { useState } from "react";
import { GlobeIcon } from "lucide-react";
import { normalizeBrowserFaviconUrl } from "./BrowserPanel.favicon";

export function BrowserFaviconIcon({ faviconUrl }: { faviconUrl: string | null }) {
  const src = normalizeBrowserFaviconUrl(faviconUrl);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <span aria-hidden="true" className="relative block size-3.5 shrink-0">
      {!src || loadedUrl !== src || failedUrl === src ? (
        <GlobeIcon className="size-3.5 text-muted-foreground" />
      ) : null}
      {src && failedUrl !== src ? (
        <img
          key={src}
          src={src}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
          className={`absolute inset-0 size-3.5 rounded-sm object-contain ${loadedUrl === src ? "" : "invisible"}`}
          onLoad={() => setLoadedUrl(src)}
          onError={() => setFailedUrl(src)}
        />
      ) : null}
    </span>
  );
}
