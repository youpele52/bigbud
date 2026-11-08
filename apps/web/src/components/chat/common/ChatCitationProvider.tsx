import { type MessageId, type ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { QuoteIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { useComposerDraftStore } from "../../../stores/composer/composer.store";
import { useSearchStore } from "../../../stores/ui/search.store";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import { annotationPanelTop } from "../../files/FilePreview.annotations.position";
import { ChatCitationContext, type ChatCitationTarget } from "./ChatCitation.context";
import { readChatCitationSelection, type ChatCitationSelection } from "./ChatCitation.selection";
import { useChatCitationHighlight } from "./ChatCitation.highlight.hook";

export function ChatCitationProvider({
  children,
  threadId,
  focusMessageId,
  onCite,
}: {
  children: ReactNode;
  threadId: ThreadId;
  focusMessageId: MessageId | null;
  onCite: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<ChatCitationSelection | null>(null);
  const [target, setTarget] = useState<ChatCitationTarget | null>(null);
  const [requestId, setRequestId] = useState(0);
  const [focusedQuestionToken, onQuestionFocused] = useState<number | null>(null);
  const highlightTarget =
    target && "requestId" in target.source && focusedQuestionToken !== requestId ? null : target;
  useChatCitationHighlight({ rootRef, target: highlightTarget, focusMessageId, requestId });

  useEffect(() => {
    setSelected(null);
    setTarget(null);
    let frame = 0;
    let selecting = false;
    let selectionActive = false;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (selecting) return;
        const root = rootRef.current;
        const current = root ? readChatCitationSelection(window.getSelection(), root) : null;
        selectionActive = current !== null;
        setSelected(current);
      });
    };
    const dismiss = () => {
      selectionActive = false;
      setSelected(null);
    };
    const scroll = () => {
      if (selectionActive) update();
    };
    const pointerdown = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        !(event.target instanceof Element) ||
        !rootRef.current?.contains(event.target) ||
        !event.target.closest("[data-chat-cite-content]")
      )
        return;
      selecting = true;
      dismiss();
    };
    const pointerup = () => {
      if (!selecting) return;
      selecting = false;
      update();
    };
    const cancel = () => {
      selecting = false;
      window.cancelAnimationFrame(frame);
      dismiss();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    document.addEventListener("selectionchange", update);
    document.addEventListener("pointerdown", pointerdown);
    document.addEventListener("pointerup", pointerup);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", keydown);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", cancel);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("pointerdown", pointerdown);
      document.removeEventListener("pointerup", pointerup);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", cancel);
    };
  }, [threadId]);

  const openCitation = useCallback(
    (citation: ChatCitationTarget) => {
      if (citation.source.threadId !== threadId) {
        toastManager.add({ type: "warning", title: "This citation belongs to another chat" });
        return;
      }
      setSelected(null);
      setTarget(citation);
      setRequestId((current) => current + 1);
      if ("messageId" in citation.source) {
        useSearchStore.getState().requestMessageFocus(threadId, citation.source.messageId);
      }
    },
    [threadId],
  );
  const context = useMemo(
    () => ({
      openCitation,
      questionFocus:
        target && "requestId" in target.source
          ? { threadId, requestId: target.source.requestId, token: requestId }
          : null,
      onQuestionFocused,
    }),
    [openCitation, target, requestId, threadId],
  );
  const cite = () => {
    if (!selected || !rootRef.current) return;
    const current = readChatCitationSelection(window.getSelection(), rootRef.current);
    if (!current || JSON.stringify(current.source) !== JSON.stringify(selected.source)) {
      setSelected(null);
      return;
    }
    useComposerDraftStore.getState().addAnnotation(threadId, {
      id: crypto.randomUUID(),
      kind: "chat",
      intent: "context",
      comment: "",
      createdAt: new Date().toISOString(),
      source: { threadId, ...current.source },
      selection: current.selection,
    });
    setSelected(null);
    window.getSelection()?.removeAllRanges();
    onCite();
  };

  return (
    <ChatCitationContext.Provider value={context}>
      <style>
        {
          "::highlight(bigbud-chat-citation) { background-color: color-mix(in oklch, var(--color-warning) 40%, transparent); color: inherit; }"
        }
      </style>
      <div ref={rootRef} className="contents">
        {children}
      </div>
      {selected
        ? createPortal(
            <div
              data-chat-cite-toolbar
              className="fixed z-50"
              style={{
                left: Math.min(
                  Math.max(52, (selected.rect.left + selected.rect.right) / 2),
                  Math.max(52, window.innerWidth - 52),
                ),
                transform: "translateX(-50%)",
                top: annotationPanelTop({
                  preferredSide: "above",
                  selectionTop: selected.rect.top,
                  selectionBottom: selected.rect.bottom,
                  panelHeight: 32,
                  viewportTop: 0,
                  viewportHeight: window.innerHeight,
                }),
              }}
            >
              <Button
                type="button"
                size="sm"
                variant="default"
                className="shadow-md"
                onPointerDown={(event) => event.preventDefault()}
                onClick={cite}
              >
                <HugeiconsIcon icon={QuoteIcon} size={14} className="size-3.5" />
                Cite
              </Button>
            </div>,
            document.body,
          )
        : null}
    </ChatCitationContext.Provider>
  );
}
