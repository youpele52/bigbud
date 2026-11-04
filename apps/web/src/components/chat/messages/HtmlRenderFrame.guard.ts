import { buildHtmlRenderDocument, HTML_RENDER_CSP } from "./HtmlRenderFrame.document";

/** The trusted embedder's frame-src policy governs inner-frame navigations, not just resources.
 * CSP is not zero-network isolation: browser APIs such as WebRTC remain available.
 */
export function buildHtmlRenderGuard(html: string): string {
  const document = JSON.stringify(buildHtmlRenderDocument(html)).replaceAll("<", "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${HTML_RENDER_CSP}">
<meta name="referrer" content="no-referrer">
<style>html,body{margin:0;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0}p{padding:16px;font:14px system-ui;color:var(--foreground);background:var(--background)}</style>
</head><body><script>
const frame = document.createElement('iframe');
frame.sandbox = 'allow-scripts';
frame.referrerPolicy = 'no-referrer';
frame.title = 'Rendered content';
let theme;
addEventListener('message', function(event) {
  if (event.source === parent && event.data?.type === 'bigbud:html-theme') {
    theme = event.data;
    frame.contentWindow?.postMessage(theme, '*');
  } else if (event.source === frame.contentWindow && event.data?.type === 'bigbud:html-height') {
    parent.postMessage({type:'bigbud:html-height',height:event.data.height}, '*');
  }
});
frame.addEventListener('load', () => { if (theme) frame.contentWindow?.postMessage(theme, '*'); });
// Only browser-generated violations can hide the visual; untrusted messages cannot.
addEventListener('securitypolicyviolation', function(event) {
  if (!event.isTrusted || event.effectiveDirective !== 'frame-src') return;
  frame.remove();
  const notice = document.createElement('p');
  notice.textContent = 'This visual attempted a blocked navigation. Regenerate it to continue.';
  if (theme?.theme) for (const key of ['--foreground','--background']) {
    if (typeof theme.theme[key] === 'string') notice.style.setProperty(key, theme.theme[key]);
  }
  document.body.replaceChildren(notice);
  parent.postMessage({type:'bigbud:html-height',height:120}, '*');
});
frame.srcdoc = ${document};
document.body.append(frame);
</script></body></html>`;
}
