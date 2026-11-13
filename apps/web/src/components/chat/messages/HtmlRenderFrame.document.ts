import dmSans from "../../../assets/fonts/DMSans-Variable.ttf?inline";
import dmSansItalic from "../../../assets/fonts/DMSans-Italic-Variable.ttf?inline";

export const HTML_RENDER_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** No application URLs, tokens or identifiers cross this boundary. */
export const HTML_RENDER_THEME_PROPERTIES = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--muted",
  "--muted-foreground",
  "--primary",
  "--primary-foreground",
  "--border",
  "--ring",
  "--accent",
  "--accent-foreground",
  "--secondary",
  "--secondary-foreground",
  "--destructive",
  "--popover",
  "--popover-foreground",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--radius",
] as const;

export function buildHtmlRenderDocument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${HTML_RENDER_CSP}">
<meta name="referrer" content="no-referrer">
<style>
@font-face { font-family:'DM Sans'; font-style:normal; font-weight:100 1000; src:url('${dmSans}') format('truetype'); }
@font-face { font-family:'DM Sans'; font-style:italic; font-weight:100 1000; src:url('${dmSansItalic}') format('truetype'); }
:root { color-scheme: light dark; --background:#fff; --foreground:#171717; --muted:#eee; --muted-foreground:#666; --border:#ddd; --primary:#2563eb; --card:var(--background);
  --accent:#f4f4f5; --accent-foreground:var(--foreground); --secondary:#f4f4f5; --secondary-foreground:var(--foreground); --destructive:#ef4444; --popover:var(--background); --popover-foreground:var(--foreground);
  --chart-1:#10b981; --chart-2:#0ea5e9; --chart-3:#f59e0b; --chart-4:#f43f5e; --chart-5:#737373; --radius:0.625rem; font-family:'DM Sans',system-ui,sans-serif; font-size:14px; }
* { box-sizing:border-box; } body { margin:0; padding:16px; color:var(--foreground); background:var(--background); line-height:1.5; overflow-wrap:anywhere; }
button,input,select,textarea { font:inherit; color:inherit; } table { border-collapse:collapse; width:100%; } th,td { padding:8px; border:1px solid var(--border); text-align:left; }
pre,code { font-family:var(--font-mono,monospace); } img,svg,canvas { max-width:100%; }
/* Zero specificity: any agent link rule, even a plain a {...}, overrides these defaults. */
:where(a[href]) { color:var(--primary); cursor:pointer; text-decoration:underline; text-decoration-thickness:1px; text-underline-offset:2px; }
</style>
<script>
addEventListener('message', function(event) {
  if (event.source !== parent || event.data?.type !== 'bigbud:html-theme') return;
  const theme = event.data.theme;
  if (!theme || typeof theme !== 'object') return;
  const allowed = ${JSON.stringify([...HTML_RENDER_THEME_PROPERTIES, "font-family", "color-scheme", "--font-mono"])};
  for (const key of allowed) if (typeof theme[key] === 'string') document.documentElement.style.setProperty(key, theme[key]);
});
addEventListener('DOMContentLoaded', function() {
  const report = () => parent.postMessage({type:'bigbud:html-height',height:document.documentElement.scrollHeight}, '*');
  new ResizeObserver(report).observe(document.body); report();
});
// Links never navigate this frame. srcdoc inherits the embedder's base URL, so a real #fragment
// click targets the app page and is blocked (hiding the visual); fragments are emulated here
// against about:srcdoc instead, and the host validates everything else.
// composedPath() also finds links inside open shadow roots; [*|href] covers SVG xlink:href.
function jumpToFragment(fragment) {
  let id = fragment;
  try { id = decodeURIComponent(fragment); } catch {}
  const target = id ? document.getElementById(id) ?? document.getElementsByName(id)[0] : null;
  scrollTo({top: target ? target.getBoundingClientRect().top + scrollY : 0});
  const oldURL = location.href;
  try { history.replaceState(history.state, '', location.href.split('#')[0] + '#' + fragment); } catch { return; }
  if (location.href !== oldURL) dispatchEvent(new HashChangeEvent('hashchange', {oldURL, newURL: location.href}));
}
document.addEventListener('click', function(event) {
  if (event.defaultPrevented) return;
  const link = event.composedPath().find((node) => node instanceof Element && node.matches('a[*|href],area[href]'));
  if (!link) return;
  event.preventDefault();
  const href = (link.getAttribute('href') ?? link.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '').trim();
  if (href.startsWith('#')) jumpToFragment(href.slice(1));
  else parent.postMessage({type:'bigbud:open-link',href}, '*');
});
</script></head><body>${html}</body></html>`;
}
