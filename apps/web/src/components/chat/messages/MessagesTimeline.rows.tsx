import { type MessageId, type TurnId } from "@bigbud/contracts";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  type ExpandedImagePreview,
  buildExpandedImagePreview,
} from "../common/ExpandedImagePreview";
import { Button } from "../../ui/button";
import { type TurnDiffSummary } from "../../../models/types";
import type { ChatImageAttachment, ChatFileAttachment } from "../../../models/types/app.types";
import { ProposedPlanCard } from "../plan/ProposedPlanCard";
import { MessageCopyButton } from "../common/MessageCopyButton";
import { SimpleWorkEntryRow } from "./MessagesTimeline.workEntry";
import { UserMessageBody } from "./MessagesTimeline.userMessage";
import {
  type AssistantMessageRow,
  AssistantMessageBody,
} from "./MessagesTimeline.assistantMessage";
import { Undo2Icon, ChevronDownIcon } from "lucide-react";
import { deriveDisplayedUserMessageState } from "~/lib/terminalContext";
import { type TimestampFormat } from "@bigbud/contracts/settings";
import { formatTimestamp } from "../../../utils/timestamp";
import { MAX_VISIBLE_WORK_LOG_ENTRIES } from "./MessagesTimeline.logic";
import { VscodeEntryIcon } from "../common/VscodeEntryIcon";

interface RenderRowContentProps {
  row: MessagesTimelineRow;
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  changedFilesExpandedByTurnId: Record<string, boolean>;
  onSetChangedFilesExpanded: (turnId: TurnId, expanded: boolean) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  nowIso: string;
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  isWorking: boolean;
  onTimelineImageLoad: () => void;
}

export function MessagesTimelineRowContent(props: RenderRowContentProps) {
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
    isWorking,
    onTimelineImageLoad,
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

          return (
            <div className="rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
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
                  <SimpleWorkEntryRow key={`work-row:${workEntry.id}`} workEntry={workEntry} />
                ))}
              </div>
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
          const userFiles = allAttachments.filter(
            (a): a is ChatFileAttachment => a.type === "file",
          );
          const userFilesWithSourcePath = userFiles.filter(
            (file): file is ChatFileAttachment & { sourcePath: string } =>
              typeof file.sourcePath === "string" && file.sourcePath.length > 0,
          );
          const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
          const terminalContexts = displayedUserMessage.contexts;
          const canRevertAgentWork = revertTurnCountByUserMessageId.has(row.message.id);
          return (
            <div className="group flex flex-col items-end gap-1">
              <div className="max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
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
                {userFiles.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {userFiles.map((file) => {
                      const dotIndex = file.name.lastIndexOf(".");
                      const baseName = dotIndex > 0 ? file.name.slice(0, dotIndex) : file.name;
                      return (
                        <div
                          key={file.id}
                          className="flex min-w-0 max-w-[180px] items-center gap-1.5 rounded-md border border-border/50 bg-background/40 px-1.5 py-1"
                        >
                          <VscodeEntryIcon
                            pathValue={file.name}
                            kind="file"
                            theme={resolvedTheme}
                            className="shrink-0 opacity-60"
                          />
                          <span
                            className="min-w-0 truncate text-[11px] text-muted-foreground/60"
                            title={file.name}
                          >
                            {baseName}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {userFilesWithSourcePath.length > 0 && (
                  <details className="mb-2 group/files">
                    <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground/50 hover:text-muted-foreground/70">
                      <ChevronDownIcon className="size-3 shrink-0 transition-transform duration-150 group-open/files:rotate-0 -rotate-90" />
                      {userFilesWithSourcePath.length === 1
                        ? "1 attached file"
                        : `${userFilesWithSourcePath.length} attached files`}
                    </summary>
                    <div className="mt-1.5 space-y-1 pl-1">
                      {userFilesWithSourcePath.map((file) => (
                        <div key={`path-${file.id}`} className="flex min-w-0 items-start gap-1.5">
                          <VscodeEntryIcon
                            pathValue={file.name}
                            kind="file"
                            theme={resolvedTheme}
                            className="mt-0.5 shrink-0 opacity-50"
                          />
                          <div
                            className="min-w-0 break-all text-[11px] text-muted-foreground/45"
                            title={file.sourcePath}
                          >
                            {file.sourcePath}
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
                {(displayedUserMessage.visibleText.trim().length > 0 ||
                  terminalContexts.length > 0) && (
                  <UserMessageBody
                    text={displayedUserMessage.visibleText}
                    terminalContexts={terminalContexts}
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
        />
      )}

      {row.kind === "proposed-plan" && (
        <div className="min-w-0 px-1 py-0.5">
          <ProposedPlanCard
            planMarkdown={row.proposedPlan.planMarkdown}
            cwd={markdownCwd}
            workspaceRoot={workspaceRoot}
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
