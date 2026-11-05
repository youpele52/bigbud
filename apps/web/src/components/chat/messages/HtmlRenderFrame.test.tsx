import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { EventId, TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import { HTML_RENDER_ACTIVITY_KIND } from "@bigbud/contracts/orchestration/htmlRender.ts";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { buildHtmlRenderDocument } from "./HtmlRenderFrame.document";
import { buildHtmlRenderGuard } from "./HtmlRenderFrame.guard";
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
