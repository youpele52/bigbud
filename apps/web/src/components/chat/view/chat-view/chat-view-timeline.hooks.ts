import { type MessageId, type TurnId } from "@bigbud/contracts";
import { useCallback, useEffect, useMemo } from "react";

import {
  deriveCompletionDividerBeforeEntryId,
  deriveTimelineEntries,
} from "../../../../logic/session";
import { useTurnDiffSummaries } from "../../../../hooks/useTurnDiffSummaries";
import { type TurnDiffSummary } from "../../../../models/types";
import {
  collectUserMessageBlobPreviewUrls,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
} from "../ChatView.logic";

import { ATTACHMENT_PREVIEW_HANDOFF_TTL_MS } from "./shared";
import { type ChatViewBaseState } from "./chat-view-base-state.hooks";
import { type ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";

interface ChatViewTimelineStateInput {
  base: ChatViewBaseState;
  thread: ChatViewThreadDerivedState;
}

export function useChatViewTimelineState({ base, thread }: ChatViewTimelineStateInput) {
  const {
    activeLatestTurn,
    activeThread,
    attachmentPreviewHandoffByMessageId,
    attachmentPreviewHandoffByMessageIdRef,
    attachmentPreviewHandoffTimeoutByMessageIdRef,
    optimisticUserMessages,
    optimisticUserMessagesRef,
    setAttachmentPreviewHandoffByMessageId,
    setOptimisticUserMessages,
  } = base;
  const { completionSummary, latestTurnSettled, workLogEntries } = thread;

  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId, attachmentPreviewHandoffByMessageIdRef]);

  const clearAttachmentPreviewHandoffs = useCallback(() => {
    for (const timeoutId of Object.values(attachmentPreviewHandoffTimeoutByMessageIdRef.current)) {
      window.clearTimeout(timeoutId);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, [
    attachmentPreviewHandoffByMessageIdRef,
    attachmentPreviewHandoffTimeoutByMessageIdRef,
    setAttachmentPreviewHandoffByMessageId,
  ]);

  useEffect(() => {
    const optimisticMessagesAtCleanup = optimisticUserMessagesRef.current;
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const message of optimisticMessagesAtCleanup) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffs, optimisticUserMessagesRef]);

  const handoffAttachmentPreviews = useCallback(
    (messageId: MessageId, previewUrls: string[]) => {
      if (previewUrls.length === 0) return;

      const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
      for (const previewUrl of previousPreviewUrls) {
        if (!previewUrls.includes(previewUrl)) {
          revokeBlobPreviewUrl(previewUrl);
        }
      }
      setAttachmentPreviewHandoffByMessageId((existing) => {
        const next = {
          ...existing,
          [messageId]: previewUrls,
        };
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });

      const existingTimeout = attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
      if (typeof existingTimeout === "number") {
        window.clearTimeout(existingTimeout);
      }
      attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId] = window.setTimeout(() => {
        const currentPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId];
        if (currentPreviewUrls) {
          for (const previewUrl of currentPreviewUrls) {
            revokeBlobPreviewUrl(previewUrl);
          }
        }
        setAttachmentPreviewHandoffByMessageId((existing) => {
          if (!(messageId in existing)) return existing;
          const next = { ...existing };
          delete next[messageId];
          attachmentPreviewHandoffByMessageIdRef.current = next;
          return next;
        });
        delete attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
      }, ATTACHMENT_PREVIEW_HANDOFF_TTL_MS);
    },
    [
      attachmentPreviewHandoffByMessageIdRef,
      attachmentPreviewHandoffTimeoutByMessageIdRef,
      setAttachmentPreviewHandoffByMessageId,
    ],
  );

  const serverMessages = activeThread?.messages;
  const timelineMessages = useMemo(() => {
    const messages = serverMessages ?? [];
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return Object.assign({}, attachment, {
                previewUrl: handoffPreviewUrl,
              });
            });

            return changed ? Object.assign({}, message, { attachments }) : message;
          });

    if (optimisticUserMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [attachmentPreviewHandoffByMessageId, optimisticUserMessages, serverMessages]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeThread.messages.length === 0) {
      return;
    }
    const serverIds = new Set(activeThread.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [activeThread, handoffAttachmentPreviews, optimisticUserMessages, setOptimisticUserMessages]);

  const { pendingUserInputs } = thread;

  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(
        timelineMessages,
        activeThread?.proposedPlans ?? [],
        workLogEntries,
        pendingUserInputs,
      ),
    [activeThread?.proposedPlans, pendingUserInputs, timelineMessages, workLogEntries],
  );
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<MessageId, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ??
          inferredCheckpointTurnCountByTurnId[summary.turnId as TurnId];
        if (typeof turnCount !== "number") {
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  const completionDividerBeforeEntryId = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!completionSummary) return null;
    return deriveCompletionDividerBeforeEntryId(timelineEntries, activeLatestTurn);
  }, [activeLatestTurn, completionSummary, latestTurnSettled, timelineEntries]);

  return {
    timelineMessages,
    timelineEntries,
    turnDiffSummaryByAssistantMessageId,
    revertTurnCountByUserMessageId,
    completionDividerBeforeEntryId,
  };
}

export type ChatViewTimelineState = ReturnType<typeof useChatViewTimelineState>;
