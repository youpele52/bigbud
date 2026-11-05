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
] as const;

export function buildHtmlRenderDocument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${HTML_RENDER_CSP}">
<meta name="referrer" content="no-referrer">
<style>
@font-face { font-family:'DM Sans'; font-style:normal; font-weight:100 1000; src:url('${dmSans}') format('truetype'); }
@font-face { font-family:'DM Sans'; font-style:italic; font-weight:100 1000; src:url('${dmSansItalic}') format('truetype'); }
:root { color-scheme: light dark; --background:#fff; --foreground:#171717; --muted:#eee; --muted-foreground:#666; --border:#ddd; --primary:#2563eb; --card:var(--background); font-family:'DM Sans',system-ui,sans-serif; font-size:14px; }
* { box-sizing:border-box; } body { margin:0; padding:16px; color:var(--foreground); background:var(--background); line-height:1.5; overflow-wrap:anywhere; }
button,input,select,textarea { font:inherit; color:inherit; } table { border-collapse:collapse; width:100%; } th,td { padding:8px; border:1px solid var(--border); text-align:left; }
pre,code { font-family:var(--font-mono,monospace); } img,svg,canvas { max-width:100%; } a { color:var(--primary); }
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
</script></head><body>${html}</body></html>`;
}
