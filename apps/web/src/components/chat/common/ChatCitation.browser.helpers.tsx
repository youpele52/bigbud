import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { useState } from "react";

import { useComposerDraftStore } from "../../../stores/composer/composer.store";
import { useSearchStore } from "../../../stores/ui/search.store";
import { ComposerAnnotationPreviews } from "../composer/ComposerAnnotationPreviews";
import { MessagesTimeline } from "../messages/MessagesTimeline";
import {
  createBaseTimelineProps,
  createMessage,
} from "../messages/MessagesTimeline.virtualization.test.fixtures";
import { ChatCitationProvider } from "./ChatCitationProvider";
import type { ChatMessage } from "../../../models/types";

export const CITE_THREAD_ID = ThreadId.makeUnsafe("cite-browser-thread");
export const CITE_MESSAGES = [
  createMessage({
    id: "cite-user",
    role: "user",
    text: "Please keep this exact phrase,  twice.",
    offsetSeconds: 0,
  }),
  createMessage({
    id: "cite-assistant",
    role: "assistant",
    text: "A **quoted phrase** appears here. Then quoted phrase repeats.",
    offsetSeconds: 1,
  }),
];

export function CitationBrowserHarness({
  messages = CITE_MESSAGES,
  threadId = CITE_THREAD_ID,
  focusMessageId,
}: {
  messages?: ChatMessage[];
  threadId?: ThreadId;
  focusMessageId?: MessageId | null;
}) {
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const focus = useSearchStore((state) => state.focusRequest);
  const draft = useComposerDraftStore((state) => state.draftsByThreadId[threadId]);
  const annotations = draft?.annotations ?? [];
  const focusedId = focusMessageId === undefined ? (focus?.messageId ?? null) : focusMessageId;
  return (
    <ChatCitationProvider threadId={threadId} focusMessageId={focusedId} onCite={() => {}}>
      <div ref={setScrollContainer} data-chat-cite-scope style={{ height: 260, overflow: "auto" }}>
        <MessagesTimeline
          {...createBaseTimelineProps({ messages })}
          scrollContainer={scrollContainer}
          focusMessageId={focusedId}
        />
      </div>
      <div data-testid="citation-composer">
        <ComposerAnnotationPreviews
          annotations={annotations}
          images={[]}
          onRemoveAnnotation={(id) =>
            useComposerDraftStore.getState().removeAnnotation(threadId, id)
          }
          onClearAnnotations={() => {}}
        />
        <textarea aria-label="Your explanation" />
      </div>
      <div data-testid="uncitable-metadata">Metadata outside the message</div>
    </ChatCitationProvider>
  );
}

export function contentFor(messageId: string): HTMLElement {
  const content = document.querySelector<HTMLElement>(
    `[data-message-id="${messageId}"] [data-chat-cite-content]`,
  );
  if (!content) throw new Error(`Message content not found: ${messageId}`);
  return content;
}

export function selectChatText(content: HTMLElement, start: number, end: number) {
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (!started && start < offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      break;
    }
    offset += length;
  }
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  return selection;
}

export function seedCitation(
  messageId = "cite-assistant",
  text = "quoted phrase",
  startOffset = 2,
) {
  useComposerDraftStore.getState().addAnnotation(CITE_THREAD_ID, {
    id: `cite-${messageId}-${startOffset}`,
    kind: "chat",
    comment: "",
    intent: "context",
    createdAt: "2026-10-29T12:00:00.000Z",
    source: {
      threadId: CITE_THREAD_ID,
      messageId: MessageId.makeUnsafe(messageId),
      role: "assistant",
    },
    selection: { text, startOffset, endOffset: startOffset + text.length },
  });
}
