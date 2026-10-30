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
    if (!target || target.source.messageId !== focusMessageId) return;
    let frame = 0;
    const deadline = performance.now() + 2_000;
    const highlight = () => {
      const content = rootRef.current?.querySelector<HTMLElement>(
        `[data-chat-cite-scope] [data-message-id="${CSS.escape(target.source.messageId)}"] [data-chat-cite-content]`,
      );
      if (!content) {
        if (performance.now() < deadline) frame = requestAnimationFrame(highlight);
        return;
      }
      const range = resolveChatCitationRange(content, target.selection);
      if (!range) return;
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
    };
    frame = requestAnimationFrame(highlight);
    const timer = window.setTimeout(() => CSS.highlights?.delete(HIGHLIGHT_NAME), 3_000);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      CSS.highlights?.delete(HIGHLIGHT_NAME);
    };
  }, [focusMessageId, requestId, rootRef, target]);
}
