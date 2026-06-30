import { buildExpandedImagePreview } from "../common/ExpandedImagePreview";
import { Button } from "../../ui/button";
import type {
  ChatFileAttachment,
  ChatImageAttachment,
  ChatPathAttachment,
} from "../../../models/types/app.types";
import { ProposedPlanCard } from "../plan/ProposedPlanCard";
import { MessageCopyButton } from "../common/MessageCopyButton";
import { MessageBranchButton } from "../common/MessageBranchButton";
import { MessageReplyButton } from "../common/MessageReplyButton";
import { MessageReplyPreview } from "../common/MessageReplyPreview";
import { SimpleWorkEntryRow, WorkEntryActionButtons } from "./MessagesTimeline.workEntry";
import { MessagesTimelineAnnotations } from "./MessagesTimeline.annotations";
import { UserMessageBody } from "./MessagesTimeline.userMessage";
import {
  type AssistantMessageRow,
  AssistantMessageBody,
} from "./MessagesTimeline.assistantMessage";
import { ThinkingMessageBody } from "./MessagesTimeline.thinking";
import { Undo2Icon, ChevronDownIcon } from "lucide-react";
import { deriveDisplayedUserMessageState } from "~/lib/terminalContext";
import { isVideoMimeType } from "~/lib/workspaceFilePreview";
import { attachmentPreviewRoutePath, toAttachmentPreviewUrl } from "~/lib/attachmentPreview";
import { formatTimestamp } from "../../../utils/timestamp";
import { MAX_VISIBLE_WORK_LOG_ENTRIES } from "./MessagesTimeline.logic";
import { cn } from "~/lib/utils";
import { type MessagesTimelineRowContentProps } from "./MessagesTimeline.shared";
import {
  UserFileReferenceChips,
  UserFileSourcePaths,
  UserThreadReferenceChips,
} from "./MessagesTimeline.userAttachments";

export function MessagesTimelineRowContent(props: MessagesTimelineRowContentProps) {
  const {
    row,
    expandedWorkGroups,
    onToggleWorkGroup,
    completionSummary,
    turnDiffSummaryByAssistantMessageId,
    changedFilesExpandedByTurnId,
    onSetChangedFilesExpanded,
    onOpenTurnDiff,
    revertTurnCountByUserMessageId,
    onRevertUserMessage,
    isRevertingCheckpoint,
    onImageExpand,
    markdownCwd,
    resolvedTheme,
    nowIso,
    timestampFormat,
    workspaceRoot,
    workspaceExecutionTargetId,
    isWorking,
    onTimelineImageLoad,
    focusedMessageId,
    onReplyToMessage,
    onOpenReplySource,
    onBranchThread,
  } = props;
  return (
    <div
      className="pb-4"
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" &&
        (() => {
          const groupId = row.id;
          const groupedEntries = row.groupedEntries;
          const isExpanded = expandedWorkGroups[groupId] ?? false;
          const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
          const visibleEntries =
            hasOverflow && !isExpanded
              ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
              : groupedEntries;
          const hiddenCount = groupedEntries.length - visibleEntries.length;
          const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
          const showHeader = hasOverflow || !onlyToolEntries;
          const groupLabel = onlyToolEntries ? "Tool calls" : "Work log";
          const showSingleEntryActionsOutside = visibleEntries.length === 1;
          const singleVisibleEntry = showSingleEntryActionsOutside ? visibleEntries[0] : undefined;

          return (
            <div className="group/work-log flex flex-col items-start gap-1">
              <div className="w-full rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
                {showHeader && (
                  <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
                    <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
                      {groupLabel} ({groupedEntries.length})
                    </p>
                    {hasOverflow && (
                      <button
                        type="button"
                        className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
                        onClick={() => onToggleWorkGroup(groupId)}
                      >
                        {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
                      </button>
                    )}
                  </div>
                )}
                <div className="space-y-0.5">
                  {visibleEntries.map((workEntry) => (
                    <SimpleWorkEntryRow
                      key={`work-row:${workEntry.id}`}
                      workEntry={workEntry}
                      executionTargetId={workspaceExecutionTargetId}
                      showActions={!showSingleEntryActionsOutside}
                    />
                  ))}
                </div>
              </div>
              {singleVisibleEntry ? (
                <div className="flex items-center gap-1.5 px-1 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/work-log:opacity-100">
                  <WorkEntryActionButtons
                    workEntry={singleVisibleEntry}
                    executionTargetId={workspaceExecutionTargetId}
                  />
                </div>
              ) : null}
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "user" &&
        (() => {
          const allAttachments = row.message.attachments ?? [];
          const userImages = allAttachments.filter(
            (a): a is ChatImageAttachment => a.type === "image",
          );
          const userVideos = allAttachments.filter(
            (attachment): attachment is ChatFileAttachment =>
              attachment.type === "file" && isVideoMimeType(attachment.mimeType),
          );
          const userThreadReferences = allAttachments.filter(
            (a): a is Extract<(typeof allAttachments)[number], { type: "thread" }> =>
              a.type === "thread",
          );
          const userFileReferences = allAttachments.filter(
            (a): a is ChatFileAttachment | ChatPathAttachment =>
              (a.type === "file" && !isVideoMimeType(a.mimeType)) || a.type === "path",
          );
          const userFilesWithSourcePath = userFileReferences.filter(
            (file): file is ChatFileAttachment & { sourcePath: string } =>
              file.type === "file" &&
              typeof file.sourcePath === "string" &&
              file.sourcePath.length > 0,
          );
          const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
          const terminalContexts = displayedUserMessage.contexts;
          const annotations = displayedUserMessage.annotations;
          const readDocument = displayedUserMessage.readDocument;
          const canRevertAgentWork = revertTurnCountByUserMessageId.has(row.message.id);
          const replyTarget = row.message.replyTo;
          return (
            <div className="group flex flex-col items-end gap-1">
              <div
                className={cn(
                  "max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3 transition-colors duration-300",
                  focusedMessageId === row.message.id ? "border-primary/70 bg-secondary/85" : "",
                )}
              >
                {replyTarget ? (
                  <div className="mb-2">
                    <MessageReplyPreview
                      replyTarget={replyTarget}
                      onClick={() => onOpenReplySource(replyTarget.messageId)}
                      className="bg-background/30"
                    />
                  </div>
                ) : null}
                {userImages.length > 0 && (
                  <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
                    {userImages.map((image) => (
                      <div
                        key={image.id}
                        className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
                      >
                        {image.previewUrl ? (
                          <button
                            type="button"
                            className="h-full w-full cursor-zoom-in"
                            aria-label={`Preview ${image.name}`}
                            onClick={() => {
                              const preview = buildExpandedImagePreview(userImages, image.id);
                              if (!preview) return;
                              onImageExpand(preview);
                            }}
                          >
                            <img
                              src={image.previewUrl}
                              alt={image.name}
                              className="h-full max-h-[220px] w-full object-cover"
                              onLoad={onTimelineImageLoad}
                              onError={onTimelineImageLoad}
                            />
                          </button>
                        ) : (
                          <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                            {image.name}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {userVideos.length > 0 && (
                  <div className="mb-2 flex max-w-[420px] flex-col gap-2">
                    {userVideos.map((video) => (
                      <div
                        key={video.id}
                        className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
                      >
                        <video
                          src={toAttachmentPreviewUrl(attachmentPreviewRoutePath(video.id))}
                          controls
                          playsInline
                          preload="metadata"
                          className="max-h-[280px] w-full bg-black"
                          aria-label={video.name}
                        >
                          <track kind="captions" />
                        </video>
                      </div>
                    ))}
                  </div>
                )}
                <UserFileReferenceChips
                  files={userFileReferences}
                  markdownCwd={markdownCwd}
                  resolvedTheme={resolvedTheme}
                />
                <UserThreadReferenceChips threads={userThreadReferences} />
                <UserFileSourcePaths
                  files={userFilesWithSourcePath}
                  markdownCwd={markdownCwd}
                  resolvedTheme={resolvedTheme}
                />
                {readDocument && (
                  <div className="mb-2 rounded-lg border border-border/50 bg-background/35 px-3 py-2">
                    <div className="space-y-1 text-xs text-muted-foreground/70">
                      <div className="font-medium text-foreground/85">
                        {readDocument.title ?? "Read document"}
                      </div>
                      <div className="break-all">
                        <span className="text-muted-foreground/55">Source:</span>{" "}
                        {readDocument.sourceUrl}
                      </div>
                      {readDocument.resolvedUrl !== readDocument.sourceUrl ? (
                        <div className="break-all">
                          <span className="text-muted-foreground/55">Resolved:</span>{" "}
                          {readDocument.resolvedUrl}
                        </div>
                      ) : null}
                    </div>
                    <details className="mt-2 group/read-doc">
                      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground/55 hover:text-muted-foreground/75">
                        <ChevronDownIcon className="size-3 shrink-0 -rotate-90 transition-transform duration-150 group-open/read-doc:rotate-0" />
                        Extracted contents
                      </summary>
                      <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/40 bg-background/45 p-2 font-mono text-[11px] leading-relaxed text-foreground/80">
                        {readDocument.text}
                      </pre>
                    </details>
                  </div>
                )}
                <MessagesTimelineAnnotations annotations={annotations} />
                {(displayedUserMessage.visibleText.trim().length > 0 ||
                  terminalContexts.length > 0) && (
                  <UserMessageBody
                    text={displayedUserMessage.visibleText}
                    terminalContexts={terminalContexts}
                    cwd={markdownCwd}
                  />
                )}
                <div className="mt-1.5 flex justify-end">
                  <p className="text-xs text-muted-foreground/50">
                    {formatTimestamp(row.message.createdAt, timestampFormat)}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 px-1 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                {displayedUserMessage.copyText && (
                  <MessageCopyButton text={displayedUserMessage.copyText} />
                )}
                <MessageReplyButton onClick={() => onReplyToMessage(row.message.id)} />
                {onBranchThread ? (
                  <MessageBranchButton onClick={() => onBranchThread(row.message.id)} />
                ) : null}
                {canRevertAgentWork && (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={isRevertingCheckpoint || isWorking}
                    onClick={() => onRevertUserMessage(row.message.id)}
                    title="Revert to this message"
                  >
                    <Undo2Icon className="size-3" />
                  </Button>
                )}
              </div>
            </div>
          );
        })()}

      {row.kind === "message" && row.message.role === "assistant" && (
        <AssistantMessageBody
          row={row as AssistantMessageRow}
          completionSummary={completionSummary}
          turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
          changedFilesExpandedByTurnId={changedFilesExpandedByTurnId}
          onSetChangedFilesExpanded={onSetChangedFilesExpanded}
          onOpenTurnDiff={onOpenTurnDiff}
          markdownCwd={markdownCwd}
          resolvedTheme={resolvedTheme}
          nowIso={nowIso}
          timestampFormat={timestampFormat}
          focusedMessageId={focusedMessageId}
          onReplyToMessage={onReplyToMessage}
          onOpenReplySource={onOpenReplySource}
          onBranchThread={onBranchThread}
        />
      )}

      {row.kind === "thinking" && (
        <ThinkingMessageBody
          row={row}
          markdownCwd={markdownCwd}
          timestampFormat={timestampFormat}
        />
      )}

      {row.kind === "proposed-plan" && (
        <div className="min-w-0 px-1 py-0.5">
          <ProposedPlanCard
            planMarkdown={row.proposedPlan.planMarkdown}
            cwd={markdownCwd}
            workspaceRoot={workspaceRoot}
            workspaceExecutionTargetId={workspaceExecutionTargetId}
          />
        </div>
      )}

      {row.kind === "user-input-question" && (
        <div className="min-w-0 px-1 py-0.5">
          <div className="rounded-xl border border-border/60 bg-card/40 px-4 py-3">
            <p className="mb-2.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
              Input required
            </p>
            <div className="space-y-4">
              {row.pendingUserInput.questions.map((question, index) => (
                <div key={question.id}>
                  <p className="mb-1 text-sm font-medium text-foreground/90">
                    {row.pendingUserInput.questions.length > 1
                      ? `${index + 1}. ${question.header || question.question}`
                      : question.header || question.question}
                  </p>
                  {question.header && question.question !== question.header && (
                    <p className="mb-1.5 text-sm text-muted-foreground/80">{question.question}</p>
                  )}
                  {question.options.length > 0 && (
                    <ul className="space-y-1 pl-3">
                      {question.options.map((option) => (
                        <li
                          key={`${question.id}:${option.label}:${option.description ?? ""}`}
                          className="text-sm text-muted-foreground/70"
                        >
                          <span className="font-medium text-foreground/70">{option.label}</span>
                          {option.description ? (
                            <span className="text-muted-foreground/55">
                              {" "}
                              — {option.description}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground/45">
              Type your answer below and press send to continue.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
