import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { EventId, TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import { HTML_RENDER_ACTIVITY_KIND } from "@bigbud/contracts/orchestration/htmlRender.ts";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import {
  buildHtmlRenderDocument,
  HTML_RENDER_CSP,
  HTML_RENDER_THEME_PROPERTIES,
} from "./HtmlRenderFrame.document";
import { buildHtmlRenderGuard } from "./HtmlRenderFrame.guard";
import { resolveHtmlRenderLink } from "./HtmlRenderFrame.links";
import {
  deriveVisibleWorkLogEntries,
  deriveTimelineEntries,
} from "../../../logic/session/session.timeline.logic";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";
import { retainUserInputHistoryActivities } from "../../../stores/main/userInputHistory.store";

const content = {
  title: "Chart",
  html: "<script>document.body.dataset.test='yes'</script><p>Chart</p>",
};
it("isolates executable content from the application DOM", () => {
  const markup = renderToStaticMarkup(<HtmlRenderFrame content={content} />);
  expect(markup).toContain('sandbox="allow-scripts"');
  expect(markup).not.toContain("allow-same-origin");
  expect(markup).toContain('referrerPolicy="no-referrer"');
  expect(markup).not.toContain("<script>");
  const document = buildHtmlRenderDocument(content.html);
  expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf(content.html));
  expect(document).toContain("connect-src 'none'");
  expect(document).toContain("font-size:14px");
  expect(document).toContain(content.html);
  expect(document).toContain("font-src data:");
  expect(document).toContain("src:url('data:");
  const guard = buildHtmlRenderGuard(content.html);
  expect(guard).not.toContain(content.html);
  expect(guard).toContain("frame-src 'none'");
  expect(guard).toContain("\\u003cscript>");
});

it("forwards the extended theme tokens with inner defaults and routes links outward", () => {
  const extended = [
    "--chart-1",
    "--chart-2",
    "--chart-3",
    "--chart-4",
    "--chart-5",
    "--accent",
    "--accent-foreground",
    "--secondary",
    "--secondary-foreground",
    "--destructive",
    "--popover",
    "--popover-foreground",
    "--radius",
  ];
  expect(HTML_RENDER_THEME_PROPERTIES).toEqual(expect.arrayContaining(extended));
  const document = buildHtmlRenderDocument(content.html);
  for (const key of extended) {
    expect(document).toContain(`${key}:`);
    expect(document).toContain(JSON.stringify(key));
  }
  expect(document).toContain("document.addEventListener('click'");
  expect(document).toContain("node.matches('a[*|href],area[href]')");
  expect(document).toContain("event.composedPath()");
  expect(document).toContain("if (href.startsWith('#')) jumpToFragment(href.slice(1));");
  expect(document).toContain(
    "history.replaceState(history.state, '', location.href.split('#')[0] + '#' + fragment)",
  );
  expect(document).toContain("event.preventDefault()");
  expect(document).toContain("type:'bigbud:open-link'");
  expect(document).toContain(":where(a[href]) { color:var(--primary); cursor:pointer;");
  expect(HTML_RENDER_CSP).toContain("frame-src 'none'");
  expect(HTML_RENDER_CSP).toContain("form-action 'none'");
  const guard = buildHtmlRenderGuard(content.html);
  expect(guard).toContain("event.data?.type === 'bigbud:open-link'");
  expect(guard).toContain("navigator.userActivation?.isActive !== true");
  expect(guard).toContain("effectiveDirective !== 'frame-src'");
});

it("opens only absolute http and https links from rendered visuals", () => {
  expect(resolveHtmlRenderLink("https://example.com/a b")).toBe("https://example.com/a%20b");
  expect(resolveHtmlRenderLink(" http://example.com ")).toBe("http://example.com/");
  for (const href of [
    "javascript:alert(1)",
    "file:///etc/hosts",
    "data:text/html,leak",
    "mailto:a@example.com",
    "/relative",
    "#section",
    "",
    null,
    42,
  ])
    expect(resolveHtmlRenderLink(href)).toBeNull();
});

it("retains historical renders despite latest-turn filtering and separates them from work accordions", () => {
  const activity = {
    id: EventId.makeUnsafe("render-1"),
    turnId: TurnId.makeUnsafe("old"),
    kind: HTML_RENDER_ACTIVITY_KIND,
    tone: "info" as const,
    summary: content.title,
    payload: content,
    createdAt: "2026-11-04T10:00:00.000Z",
  };
  expect(retainUserInputHistoryActivities([activity], 0)).toEqual([activity]);
  const entries = deriveVisibleWorkLogEntries([activity], TurnId.makeUnsafe("new"));
  expect(entries).toHaveLength(1);
  const rows = deriveMessagesTimelineRows({
    timelineEntries: deriveTimelineEntries([], [], entries),
    completionDividerBeforeEntryId: null,
    isWorking: false,
    activeTurnStartedAt: null,
  });
  expect(rows).toMatchObject([{ kind: "html-render", content }]);
});
