import type { BrowserSearchEngine } from "@bigbud/contracts/constants/browser.constant.ts";

export const BROWSER_SEARCH_OPTIONS = {
  duckduckgo: { label: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
  google: { label: "Google", url: "https://www.google.com/search?q=" },
  brave: { label: "Brave Search", url: "https://search.brave.com/search?q=" },
  bing: { label: "Bing", url: "https://www.bing.com/search?q=" },
  startpage: { label: "Startpage", url: "https://www.startpage.com/sp/search?query=" },
} as const satisfies Record<BrowserSearchEngine, { label: string; url: string }>;
