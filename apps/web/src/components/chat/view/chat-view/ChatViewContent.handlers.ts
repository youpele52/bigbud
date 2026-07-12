import { type MessageId } from "@bigbud/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { deriveDisplayedUserMessageState } from "~/lib/terminalContext";
import { useSearchStore } from "~/stores/ui";

import { deriveUserTurnAnchorsFromThreadMessages } from "../../scroller/chatScroll.timelineRows";
import { type ChatViewBaseState } from "./chat-view-base-state.hooks";
import { type ChatViewRuntimeState } from "./chat-view-runtime.hooks";
import { type ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";

const REPLY_PREVIEW_MAX_CHARS = 240;

function truncateReplyPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= REPLY_PREVIEW_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, REPLY_PREVIEW_MAX_CHARS - 3).trimEnd()}...`;
}

export function useChatViewContentHandlers({
  base,
  runtime,
  thread,
}: {
  base: ChatViewBaseState;
  runtime: ChatViewRuntimeState;
  thread: ChatViewThreadDerivedState;
}) {
  const searchFocusRequest = useSearchStore((state) => state.focusRequest);
  const clearSearchFocusRequest = useSearchStore((state) => state.clearFocusRequest);
  const [focusMessageId, setFocusMessageId] = useState<MessageId | null>(null);

  const handleReplyToMessage = useCallback(
    (messageId: MessageId) => {
      const message = base.activeThread?.messages.find((entry) => entry.id === messageId);
      if (!message) {
        return;
      }
      base.setComposerReplyTarget(base.activeThread!.id, {
        messageId: message.id,
        role: message.role,
        createdAt: message.createdAt,
        excerpt: truncateReplyPreview(
          message.role === "user"
            ? deriveDisplayedUserMessageState(message.text).copyText || "(empty message)"
            : message.text || "(empty message)",
        ),
      });
      runtime.scheduleComposerFocus();
    },
    [base, runtime],
  );

  const handleOpenReplySource = useCallback(
    (messageId: MessageId) => {
      runtime.scrollBehavior.scrollToMessage(messageId, {
        align: "center",
        behavior: "smooth",
      });
      setFocusMessageId(null);
      window.requestAnimationFrame(() => {
        setFocusMessageId(messageId);
      });
    },
    [runtime.scrollBehavior],
  );

  const userTurnAnchors = useMemo(
    () => deriveUserTurnAnchorsFromThreadMessages(base.activeThread?.messages ?? []),
    [base.activeThread?.messages],
  );

  const handleJumpToTurn = useCallback(
    (messageId: MessageId) => {
      const didScroll = runtime.scrollBehavior.scrollToMessage(messageId, {
        align: "start",
        behavior: "smooth",
      });
      if (!didScroll) {
        handleOpenReplySource(messageId);
      }
    },
    [handleOpenReplySource, runtime.scrollBehavior],
  );

  useEffect(() => {
    if (!searchFocusRequest || searchFocusRequest.threadId !== base.activeThread?.id) {
      return;
    }
    handleOpenReplySource(searchFocusRequest.messageId);
    clearSearchFocusRequest(searchFocusRequest.requestId);
  }, [base.activeThread?.id, clearSearchFocusRequest, handleOpenReplySource, searchFocusRequest]);

  const handleClosePlanCard = useCallback(() => {
    base.setPlanCardOpen(false);
    base.planCardDismissedForTurnRef.current =
      thread.activePlan?.turnId ?? thread.cardProposedPlan?.turnId ?? "__dismissed__";
  }, [base, thread.activePlan?.turnId, thread.cardProposedPlan?.turnId]);

  return {
    focusMessageId,
    handleClosePlanCard,
    handleJumpToTurn,
    handleOpenReplySource,
    handleReplyToMessage,
    userTurnAnchors,
  };
}
