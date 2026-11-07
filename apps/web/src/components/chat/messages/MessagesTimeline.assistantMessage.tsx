import type { MessageId, TurnId } from "@bigbud/contracts";
import { TerminalIcon } from "lucide-react";
import { stableVerbFromId } from "../../../utils/copy";
import { formatElapsed } from "../../../logic/session";
import { type TurnDiffSummary } from "../../../models/types";
import { activitySectionLabelTypography } from "../common/ActivityAccordion";
import ChatMarkdown from "../common/ChatMarkdown";
import { MessageBranchButton } from "../common/MessageBranchButton";
import { MessageReplyButton } from "../common/MessageReplyButton";
import { MessageReplyPreview } from "../common/MessageReplyPreview";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { type TimestampFormat } from "@bigbud/contracts/settings";
import { useMemo } from "react";
import { useSettings } from "../../../hooks/useSettings";
import { useLocalDay } from "../../../hooks/useLocalDay";
import { terminalFontFamilyFromSettings } from "../../terminal/terminalTypography";
import { cn } from "~/lib/utils";
import { deriveAutomationAssistantDisplayState } from "~/lib/automation";
import type { MarkdownAnchorClick } from "../../common/BaseMarkdown";

import { formatMessageMeta } from "./MessagesTimeline.assistantMessage.meta";
import { MessagesTimelineAutomationRequest } from "./MessagesTimeline.automationRequest";
import { AssistantTurnChangedFiles } from "./MessagesTimeline.changedFiles";
import { OlderTurnWorkLogButton } from "./MessagesTimeline.turnActivitiesButton";
import {
  TimelineMessageCopyButton,
  TruncatedMessageNotice,
} from "./MessagesTimeline.truncatedMessageNotice";
import type {
  ActivityAccordionOpenById,
  SetActivityAccordionOpen,
} from "../common/ActivityAccordion.state";

const SHELL_OUTPUT_MIN_WIDTH = "48rem";
const SHELL_OUTPUT_MAX_WIDTH = "960px";

export type AssistantMessageRow = Extract<MessagesTimelineRow, { kind: "message" }> & {
  message: { role: "assistant" };
};

function isShellOutputMessage(row: AssistantMessageRow): boolean {
  return row.message.turnId === null && row.message.text.startsWith("$ ");
}

interface AssistantMessageBodyProps {
  row: AssistantMessageRow;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  changedFilesExpandedByTurnId: Record<string, boolean>;
  onSetChangedFilesExpanded: (turnId: TurnId, expanded: boolean) => void;
  activityAccordionOpenById: ActivityAccordionOpenById;
  onSetActivityAccordionOpen: SetActivityAccordionOpen;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  markdownCwd: string | undefined;
  onMarkdownAnchorClick?: ((input: MarkdownAnchorClick) => void) | undefined;
  resolvedTheme: "light" | "dark";
  nowIso: string;
  timestampFormat: TimestampFormat;
  focusedMessageId: MessageId | null;
  onReplyToMessage: (messageId: MessageId) => void;
  onOpenReplySource: (messageId: MessageId) => void;
  onBranchThread: ((messageId: MessageId) => void) | undefined;
}

function ShellOutputCard(props: {
  messageText: string;
  terminalTypography: { fontFamily: string; fontSize: number };
}) {
  const { messageText, terminalTypography } = props;

  return (
    <div
      className="inline-block w-fit max-w-full rounded-xl border border-border/60 bg-card/40 px-4 py-3"
      style={{
        minWidth: `min(100%, ${SHELL_OUTPUT_MIN_WIDTH})`,
      }}
    >
      <div className={cn("mb-2 flex items-center gap-1.5", activitySectionLabelTypography)}>
        <TerminalIcon className="size-3 shrink-0" />
        <span>Shell</span>
      </div>
      <div
        className="max-w-full overflow-x-auto overflow-y-hidden rounded-md"
        style={{
          maxWidth: `min(100%, ${SHELL_OUTPUT_MAX_WIDTH})`,
          minWidth: `min(100%, ${SHELL_OUTPUT_MIN_WIDTH})`,
        }}
      >
        <pre
          data-chat-cite-content
          className="m-0 inline-block min-w-full whitespace-pre text-foreground/95"
          style={{
            width: "max-content",
            fontFamily: terminalTypography.fontFamily,
            fontSize: `${terminalTypography.fontSize}px`,
            lineHeight: 1.2,
          }}
        >
          {messageText}
        </pre>
      </div>
    </div>
  );
}

function AssistantMessageMeta({
  createdAt,
  duration,
  timestampFormat,
}: {
  createdAt: string;
  duration: string | null;
  timestampFormat: TimestampFormat;
}) {
  const day = useLocalDay();
  return <>{formatMessageMeta(createdAt, duration, timestampFormat, new Date(day))}</>;
}

export function AssistantMessageBody({
  row,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  changedFilesExpandedByTurnId,
  onSetChangedFilesExpanded,
  activityAccordionOpenById,
  onSetActivityAccordionOpen,
  onOpenTurnDiff,
  markdownCwd,
  onMarkdownAnchorClick,
  resolvedTheme,
  nowIso,
  timestampFormat,
  focusedMessageId,
  onReplyToMessage,
  onOpenReplySource,
  onBranchThread,
}: AssistantMessageBodyProps) {
  const messageText =
    row.message.text || (row.message.streaming ? "" : `(${stableVerbFromId(row.message.id)}...)`);
  const automationDisplay = deriveAutomationAssistantDisplayState(messageText);
  const renderedMessageText = automationDisplay.request
    ? automationDisplay.visibleText
    : messageText;
  const shellOutputMessage = isShellOutputMessage(row);
  const replyTarget = row.message.replyTo;
  const settings = useSettings();
  const terminalTypography = useMemo(
    () => ({
      fontFamily: terminalFontFamilyFromSettings(settings.terminalFontFamily),
      fontSize: settings.terminalFontSize,
    }),
    [settings.terminalFontFamily, settings.terminalFontSize],
  );

  return (
    <>
      {row.showCompletionDivider && (
        <div className="my-3 flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
            {completionSummary ?? "Response"}
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>
      )}
      <div
        className={cn(
          "group min-w-0 rounded-xl px-1 py-0.5 transition-colors duration-300",
          focusedMessageId === row.message.id ? "bg-card/55" : "",
        )}
      >
        {replyTarget ? (
          <div className="mb-2 max-w-[80%]">
            <MessageReplyPreview
              replyTarget={replyTarget}
              onClick={() => onOpenReplySource(replyTarget.messageId)}
            />
          </div>
        ) : null}
        {shellOutputMessage ? (
          <ShellOutputCard messageText={messageText} terminalTypography={terminalTypography} />
        ) : (
          <>
            <div data-chat-cite-content>
              <ChatMarkdown
                text={renderedMessageText}
                cwd={markdownCwd}
                isStreaming={Boolean(row.message.streaming)}
                onAnchorClick={onMarkdownAnchorClick}
              />
            </div>
            {automationDisplay.request ? (
              <MessagesTimelineAutomationRequest
                messageCreatedAt={row.message.createdAt}
                messageId={row.message.id}
                request={automationDisplay.request}
                requestPayload={automationDisplay.requestPayload}
                streaming={Boolean(row.message.streaming)}
              />
            ) : null}
          </>
        )}
        <TruncatedMessageNotice message={row.message} />
        <AssistantTurnChangedFiles
          messageId={row.message.id}
          turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
          changedFilesExpandedByTurnId={changedFilesExpandedByTurnId}
          onSetChangedFilesExpanded={onSetChangedFilesExpanded}
          activityAccordionOpenById={activityAccordionOpenById}
          onSetActivityAccordionOpen={onSetActivityAccordionOpen}
          onOpenTurnDiff={onOpenTurnDiff}
          resolvedTheme={resolvedTheme}
        />
        <div className="mt-1.5 flex justify-start">
          <div
            data-message-footer="assistant"
            className="flex min-w-0 max-w-full flex-wrap items-center gap-2 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100"
          >
            {row.showAssistantCopyButton && messageText.length > 0 ? (
              <TimelineMessageCopyButton message={row.message} text={messageText} />
            ) : null}
            {row.showAssistantCopyButton ? (
              <MessageReplyButton onClick={() => onReplyToMessage(row.message.id)} />
            ) : null}
            {onBranchThread ? (
              <MessageBranchButton onClick={() => onBranchThread(row.message.id)} />
            ) : null}
            {row.showAssistantCopyButton ? <OlderTurnWorkLogButton message={row.message} /> : null}
            <p className="min-w-0 max-w-full break-words text-[10px] text-muted-foreground/30">
              <AssistantMessageMeta
                createdAt={row.message.createdAt}
                duration={
                  row.message.streaming
                    ? formatElapsed(row.durationStart, nowIso)
                    : formatElapsed(row.durationStart, row.message.completedAt)
                }
                timestampFormat={timestampFormat}
              />
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
