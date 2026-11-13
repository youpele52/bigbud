/** One host-opened link per frame per interval, so a script cannot flood the browser. */
export const HTML_RENDER_LINK_INTERVAL_MS = 1000;

/** Returns a normalized http(s) URL, or null for anything a visual must not open. */
export function resolveHtmlRenderLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
