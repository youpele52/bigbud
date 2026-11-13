export type HtmlRenderScheme = "light" | "dark";

/** Maps a computed `color-scheme` to a single app scheme; `light dark`/`normal` stay undecided. */
export function resolveHtmlRenderScheme(
  colorScheme: string | null | undefined,
): HtmlRenderScheme | null {
  const words = new Set((colorScheme ?? "").trim().split(/\s+/));
  if (words.has("dark") && !words.has("light")) return "dark";
  if (words.has("light") && !words.has("dark")) return "light";
  return null;
}

/** Reads the host app's current scheme; null outside a browser. */
export function readHostHtmlRenderScheme(): HtmlRenderScheme | null {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") return null;
  return resolveHtmlRenderScheme(getComputedStyle(window.document.documentElement).colorScheme);
}

/**
 * Inner-document runtime (inside the bigbud IIFE). Embedded frames report the OS appearance for
 * prefers-color-scheme, not bigbud's theme, so agent media queries and matchMedia() calls are
 * rewritten to follow the app scheme. Known limit: MediaQueryList change listeners and rules
 * inserted through CSSOM after load keep the OS value.
 */
export function buildHtmlRenderSchemeScript(initial: HtmlRenderScheme | null): string {
  return `
let bigbudScheme = ${JSON.stringify(initial)};
const schemeQuery = /\\(\\s*prefers-color-scheme\\s*:\\s*(light|dark)\\s*\\)/gi;
function rewriteScheme(query) {
  if (!bigbudScheme) return query;
  return query.replace(schemeQuery, (_, wanted) => wanted.toLowerCase() === bigbudScheme ? '(min-width: 0px)' : '(max-width: -1px)');
}
const nativeMatchMedia = matchMedia.bind(window);
window.matchMedia = function(query) { return nativeMatchMedia(rewriteScheme(String(query))); };
const originalMedia = new WeakMap();
function rewriteMediaList(owner, media) {
  if (!media) return;
  if (!originalMedia.has(owner)) originalMedia.set(owner, media.mediaText);
  const original = originalMedia.get(owner);
  if (!/prefers-color-scheme/i.test(original)) return;
  const next = rewriteScheme(original);
  if (media.mediaText !== next) media.mediaText = next;
}
function rewriteRules(rules) {
  for (const rule of rules) {
    if (rule.media) rewriteMediaList(rule, rule.media);
    if (rule.cssRules) rewriteRules(rule.cssRules);
  }
}
function applySchemeToStyles() {
  for (const sheet of document.styleSheets) {
    if (sheet.ownerNode?.hasAttribute?.('data-bigbud')) continue;
    rewriteMediaList(sheet, sheet.media);
    try { rewriteRules(sheet.cssRules); } catch {}
  }
}
function setScheme(value) {
  if (value !== 'light' && value !== 'dark' && value !== null) return;
  bigbudScheme = value;
  applySchemeToStyles();
}`;
}
