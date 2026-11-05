import { type MessageId } from "@bigbud/contracts/core/baseSchemas";
import { useEffect, type RefObject } from "react";

import type { ChatCitationTarget } from "./ChatCitation.context";
import { resolveChatCitationRange } from "./ChatCitation.selection";

const HIGHLIGHT_NAME = "bigbud-chat-citation";

export function useChatCitationHighlight({
  rootRef,
  target,
  focusMessageId,
  requestId,
}: {
  rootRef: RefObject<HTMLElement | null>;
  target: ChatCitationTarget | null;
  focusMessageId: MessageId | null;
  requestId: number;
}) {
  useEffect(() => {
    if (!target) return;
    const source = target.source;
    if ("messageId" in source && source.messageId !== focusMessageId) return;
    const selector =
      "requestId" in source
        ? `[data-chat-cite-request-id="${CSS.escape(source.requestId)}"] [data-chat-cite-question-id="${CSS.escape(source.questionId)}"] [data-chat-cite-region="${source.region}"]`
        : `[data-message-id="${CSS.escape(source.messageId)}"] [data-chat-cite-content]`;
    let frame = 0;
    let timer = 0;
    const revealedHeadings: HTMLElement[] = [];
    const clearHighlight = () => {
      CSS.highlights?.delete(HIGHLIGHT_NAME);
      for (const heading of revealedHeadings) heading.hidden = true;
    };
    const deadline = performance.now() + 2_000;
    const highlight = () => {
      const content = rootRef.current?.querySelector<HTMLElement>(
        `[data-chat-cite-scope] ${selector}`,
      );
      if (
        !content ||
        content.closest("details:not([open])") ||
        (!("requestId" in source) && content.getClientRects().length === 0)
      ) {
        if (performance.now() < deadline) frame = requestAnimationFrame(highlight);
        return;
      }
      const range = resolveChatCitationRange(content, target.selection);
      if (!range) return;
      // Answered history hides a redundant "Question" heading, but a saved
      // selection may include it. Reveal only the heading intersecting this range.
      if ("requestId" in source) {
        for (const heading of content.querySelectorAll<HTMLElement>(
          '[data-chat-cite-region="header"][hidden]',
        )) {
          if (!range.intersectsNode(heading)) continue;
          heading.hidden = false;
          revealedHeadings.push(heading);
        }
        const hiddenHeading = content.closest<HTMLElement>(
          '[data-chat-cite-region="header"][hidden]',
        );
        if (hiddenHeading) {
          hiddenHeading.hidden = false;
          revealedHeadings.push(hiddenHeading);
        }
      }
      if ("highlights" in CSS && typeof Highlight !== "undefined") {
        CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range));
      }
      const scroller = content.closest<HTMLElement>("[data-chat-cite-scope]");
      if (scroller) {
        const rect = range.getBoundingClientRect();
        const viewport = scroller.getBoundingClientRect();
        scroller.scrollBy({
          top: rect.top - viewport.top - viewport.height / 2,
          behavior: "smooth",
        });
      }
      timer = window.setTimeout(clearHighlight, 3_000);
    };
    frame = requestAnimationFrame(highlight);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      clearHighlight();
    };
  }, [focusMessageId, requestId, rootRef, target]);
}
