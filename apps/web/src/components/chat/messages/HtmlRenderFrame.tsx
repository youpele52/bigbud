import { useEffect, useMemo, useRef, useState } from "react";
import type { HtmlRenderInput } from "@bigbud/contracts/orchestration/htmlRender.ts";
import { openLinkFromClick } from "~/lib/openLink";
import { HTML_RENDER_THEME_PROPERTIES } from "./HtmlRenderFrame.document";
import { buildHtmlRenderGuard } from "./HtmlRenderFrame.guard";
import { HTML_RENDER_LINK_INTERVAL_MS, resolveHtmlRenderLink } from "./HtmlRenderFrame.links";

/** Opaque-origin frame: scripts never receive application state or a credential-bearing URL. */
export function HtmlRenderFrame({ content }: { content: HtmlRenderInput }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const lastLinkOpenedAt = useRef(Number.NEGATIVE_INFINITY);
  const [height, setHeight] = useState(360);
  const document = useMemo(() => buildHtmlRenderGuard(content.html), [content.html]);
  function sendTheme() {
    const styles = getComputedStyle(window.document.documentElement);
    const body = getComputedStyle(window.document.body);
    const theme: Record<string, string> = {
      "font-family": body.fontFamily,
      "color-scheme": styles.colorScheme,
      "--font-mono": styles.getPropertyValue("--font-mono"),
    };
    for (const key of HTML_RENDER_THEME_PROPERTIES) theme[key] = styles.getPropertyValue(key);
    frame.current?.contentWindow?.postMessage({ type: "bigbud:html-theme", theme }, "*");
  }
  useEffect(() => {
    const observer = new MutationObserver(sendTheme);
    observer.observe(window.document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    observer.observe(window.document.body, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    function openRequestedLink(value: unknown) {
      const href = resolveHtmlRenderLink(value);
      const now = Date.now();
      if (!href || now - lastLinkOpenedAt.current < HTML_RENDER_LINK_INTERVAL_MS) return;
      lastLinkOpenedAt.current = now;
      openLinkFromClick(href);
    }
    function receive(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "bigbud:open-link") return openRequestedLink(event.data.href);
      if (event.data?.type !== "bigbud:html-height") return;
      const value = event.data.height;
      if (typeof value === "number" && Number.isFinite(value))
        setHeight(Math.max(120, Math.min(1200, Math.ceil(value))));
    }
    window.addEventListener("message", receive);
    return () => {
      observer.disconnect();
      window.removeEventListener("message", receive);
    };
  }, []);
  return (
    <section
      className="overflow-hidden rounded-lg border border-border bg-card"
      aria-label={content.title}
    >
      <div className="border-b border-border px-4 py-2 text-sm font-medium">{content.title}</div>
      <iframe
        ref={frame}
        title={content.title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={document}
        onLoad={sendTheme}
        className="block w-full border-0"
        style={{ height }}
      />
    </section>
  );
}
