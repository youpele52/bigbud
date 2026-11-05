export const BROWSER_SEARCH_ENGINES = [
  "duckduckgo",
  "google",
  "brave",
  "bing",
  "startpage",
] as const;
export type BrowserSearchEngine = (typeof BROWSER_SEARCH_ENGINES)[number];
export const DEFAULT_BROWSER_SEARCH_ENGINE: BrowserSearchEngine = "duckduckgo";
