import type { BrowserSearchEngine } from "@bigbud/contracts/constants/browser.constant.ts";
import { BROWSER_SEARCH_OPTIONS } from "~/constants/browserSearch";
import { normalizeBrowserFaviconUrl } from "./BrowserPanel.favicon";
import { filterBrowserHistory, type BrowserVisitRecord } from "./BrowserPanel.history";
import {
  buildBrowserSearchUrl,
  getUnsupportedBrowserOmniboxScheme,
  resolveBrowserOmniboxInput,
} from "./BrowserPanel.omnibox";

export interface BrowserSuggestion {
  readonly kind: "search" | "url";
  readonly url: string;
  readonly label: string;
}

/** Builds local suggestions without sending the typed text to any network service. */
export function getBrowserSuggestions(
  history: BrowserVisitRecord[],
  input: string,
  engine: BrowserSearchEngine,
): BrowserSuggestion[] {
  const query = input.trim();
  if (getUnsupportedBrowserOmniboxScheme(query)) return [];
  const suggestions: BrowserSuggestion[] = [];
  if (query) {
    const searchUrl = buildBrowserSearchUrl(query, engine);
    suggestions.push({
      kind: "search",
      url: searchUrl,
      label: `${query} — Search ${BROWSER_SEARCH_OPTIONS[engine].label}`,
    });
    const url = resolveBrowserOmniboxInput(query, engine);
    if (url && url !== searchUrl) suggestions.push({ kind: "url", url, label: url });
  }
  for (const url of filterBrowserHistory(history, query)) {
    if (!suggestions.some((suggestion) => suggestion.url === url))
      suggestions.push({ kind: "url", url, label: url });
  }
  return suggestions;
}

/** Prefers observed icons, falling back to the destination origin without its path or query. */
export function getBrowserFaviconUrl(
  url: string,
  history: BrowserVisitRecord[],
  page?: { url: string | null; faviconUrl: string | null },
  allowFallback = true,
): string | null {
  try {
    const destination = new URL(url);
    if (destination.protocol !== "http:" && destination.protocol !== "https:") return null;
    if (destination.username || destination.password) return null;
    const observedPageUrl = normalizeBrowserFaviconUrl(page?.url);
    if (observedPageUrl && new URL(observedPageUrl).origin === destination.origin) {
      const icon = normalizeBrowserFaviconUrl(page?.faviconUrl);
      if (icon) return icon;
    }
    const exact = history.find((visit) => visit.normalizedUrl === destination.href);
    return (
      normalizeBrowserFaviconUrl(exact?.faviconUrl) ??
      normalizeBrowserFaviconUrl(
        history.find((visit) => visit.origin === destination.origin && visit.faviconUrl)
          ?.faviconUrl,
      ) ??
      (allowFallback ? `${destination.origin}/favicon.ico` : null)
    );
  } catch {
    return null;
  }
}
