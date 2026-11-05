import type { MessageId } from "@bigbud/contracts/core/baseSchemas";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";

import { useChatCitationActions } from "../common/ChatCitation.context";
import type { SetActivityAccordionOpen } from "../common/ActivityAccordion.state";
import { timelineRowAccordionId } from "./MessagesTimeline.accordion";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { useQuestionCitationHistory } from "./MessagesTimeline.questionHistory.hook";

type TimelineFocusOptions = {
  rows: MessagesTimelineRow[];
  virtualizedRowCount: number;
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  timelineRootRef: RefObject<HTMLDivElement | null>;
  onSetActivityAccordionOpen: SetActivityAccordionOpen;
};

/** Shared virtual-row reveal and scroll for message and question source navigation. */
function useTimelineRowFocus({
  rows,
  virtualizedRowCount,
  rowVirtualizer,
  timelineRootRef,
  onSetActivityAccordionOpen,
  token,
  index,
  attribute,
  id,
  onFocused,
}: TimelineFocusOptions & {
  token: unknown;
  index: number;
  attribute: "data-chat-cite-request-id" | "data-message-id";
  id: string;
  onFocused: () => void;
}) {
  const processed = useRef<unknown>(null);
  const prepared = useRef<unknown>(null);
  const onFocusedRef = useRef(onFocused);
  onFocusedRef.current = onFocused;
  useEffect(() => {
    if (!token) {
      processed.current = null;
      prepared.current = null;
      return;
    }
    if (processed.current === token || index < 0) return;
    const row = rows[index];
    if (!row) return;
    if (prepared.current !== token) {
      prepared.current = token;
      const accordionId = timelineRowAccordionId(row);
      if (accordionId) onSetActivityAccordionOpen(accordionId, true);
      if (index < virtualizedRowCount) rowVirtualizer.scrollToIndex(index, { align: "center" });
    }
    let frame = 0;
    const deadline = performance.now() + 2_000;
    const reveal = () => {
      const element = timelineRootRef.current?.querySelector<HTMLElement>(
        `[${attribute}="${CSS.escape(id)}"]`,
      );
      if (!element) {
        if (performance.now() < deadline) frame = requestAnimationFrame(reveal);
        return;
      }
      processed.current = token;
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      onFocusedRef.current();
    };
    frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [
    index,
    onSetActivityAccordionOpen,
    rowVirtualizer,
    rows,
    attribute,
    id,
    timelineRootRef,
    token,
    virtualizedRowCount,
  ]);
}

export function useTimelineCitationFocus({
  focusMessageId,
  ...options
}: TimelineFocusOptions & { focusMessageId: MessageId | null }) {
  const actions = useChatCitationActions();
  const focus = actions?.questionFocus;
  const [focusedMessage, setFocusedMessage] = useState<{ id: MessageId } | null>(null);
  const questionIndex = focus
    ? options.rows.findIndex(
        (row) =>
          row.kind === "user-input-question" && row.pendingUserInput.requestId === focus.requestId,
      )
    : -1;
  useQuestionCitationHistory(questionIndex >= 0);
  useTimelineRowFocus({
    ...options,
    token: focus,
    index: questionIndex,
    attribute: "data-chat-cite-request-id",
    id: focus?.requestId ?? "",
    onFocused: () => {
      if (focus) actions?.onQuestionFocused(focus.token);
    },
  });
  useTimelineRowFocus({
    ...options,
    token: focusMessageId,
    index: focusMessageId
      ? options.rows.findIndex((row) => row.kind === "message" && row.message.id === focusMessageId)
      : -1,
    attribute: "data-message-id",
    id: focusMessageId ?? "",
    onFocused: () => setFocusedMessage(focusMessageId ? { id: focusMessageId } : null),
  });
  useEffect(() => {
    if (!focusedMessage) return;
    const timer = window.setTimeout(() => setFocusedMessage(null), 2_000);
    return () => window.clearTimeout(timer);
  }, [focusedMessage]);
  return focusedMessage?.id ?? null;
}
