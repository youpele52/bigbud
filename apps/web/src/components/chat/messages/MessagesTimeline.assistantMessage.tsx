import type { MessageId, TurnId } from "@bigbud/contracts";
import { stableVerbFromId } from "../../../utils/copy";
import { formatElapsed } from "../../../logic/session";
import { type TurnDiffSummary } from "../../../models/types";
import { summarizeTurnDiffStats } from "../../../lib/turnDiffTree";
import ChatMarkdown from "../common/ChatMarkdown";
import { Button } from "../../ui/button";
import { MessageCopyButton } from "../common/MessageCopyButton";
import { DiffStatLabel, hasNonZeroStat } from "../diff-display/DiffStatLabel";
import { ChangedFilesTree } from "../diff-display/ChangedFilesTree";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { type TimestampFormat } from "@bigbud/contracts/settings";
import { formatTimestamp } from "../../../utils/timestamp";

export type AssistantMessageRow = Extract<MessagesTimelineRow, { kind: "message" }> & {
  message: { role: "assistant" };
};

interface AssistantMessageBodyProps {
  row: AssistantMessageRow;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  changedFilesExpandedByTurnId: Record<string, boolean>;
  onSetChangedFilesExpanded: (turnId: TurnId, expanded: boolean) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  nowIso: string;
  timestampFormat: TimestampFormat;
}

export function AssistantMessageBody({
  row,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  changedFilesExpandedByTurnId,
  onSetChangedFilesExpanded,
  onOpenTurnDiff,
  markdownCwd,
  resolvedTheme,
  nowIso,
  timestampFormat,
}: AssistantMessageBodyProps) {
  const messageText =
    row.message.text || (row.message.streaming ? "" : `(${stableVerbFromId(row.message.id)}...)`);

  return (
    <>
      {row.showCompletionDivider && (
        <div className="my-3 flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
            {completionSummary ? `Response • ${completionSummary}` : "Response"}
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>
      )}
      <div className="min-w-0 px-1 py-0.5">
        <ChatMarkdown
          text={messageText}
          cwd={markdownCwd}
          isStreaming={Boolean(row.message.streaming)}
        />
        <AssistantTurnDiffCard
          messageId={row.message.id}
          turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
          changedFilesExpandedByTurnId={changedFilesExpandedByTurnId}
          onSetChangedFilesExpanded={onSetChangedFilesExpanded}
          onOpenTurnDiff={onOpenTurnDiff}
          resolvedTheme={resolvedTheme}
        />
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <div className="min-w-0">
            {row.showAssistantCopyButton && messageText.length > 0 ? (
              <MessageCopyButton text={messageText} />
            ) : null}
          </div>
          <p className="shrink-0 text-[10px] text-muted-foreground/30">
            {formatMessageMeta(
              row.message.createdAt,
              row.message.streaming
                ? formatElapsed(row.durationStart, nowIso)
                : formatElapsed(row.durationStart, row.message.completedAt),
              timestampFormat,
            )}
          </p>
        </div>
      </div>
    </>
  );
}

interface AssistantTurnDiffCardProps {
  messageId: MessageId;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  changedFilesExpandedByTurnId: Record<string, boolean>;
  onSetChangedFilesExpanded: (turnId: TurnId, expanded: boolean) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  resolvedTheme: "light" | "dark";
}

function AssistantTurnDiffCard({
  messageId,
  turnDiffSummaryByAssistantMessageId,
  changedFilesExpandedByTurnId,
  onSetChangedFilesExpanded,
  onOpenTurnDiff,
  resolvedTheme,
}: AssistantTurnDiffCardProps) {
  const turnSummary = turnDiffSummaryByAssistantMessageId.get(messageId);
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;

  const summaryStat = summarizeTurnDiffStats(checkpointFiles);
  const changedFileCountLabel = String(checkpointFiles.length);
  const allDirectoriesExpanded = changedFilesExpandedByTurnId[turnSummary.turnId] ?? true;

  return (
    <div className="mt-2 rounded-lg border border-border/80 bg-card/45 p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
          <span>Changed files ({changedFileCountLabel})</span>
          {hasNonZeroStat(summaryStat) && (
            <>
              <span className="mx-1">•</span>
              <DiffStatLabel additions={summaryStat.additions} deletions={summaryStat.deletions} />
            </>
          )}
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-scroll-anchor-ignore
            onClick={() => onSetChangedFilesExpanded(turnSummary.turnId, !allDirectoriesExpanded)}
          >
            {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path)}
          >
            View diff
          </Button>
        </div>
      </div>
      <ChangedFilesTree
        key={`changed-files-tree:${turnSummary.turnId}`}
        turnId={turnSummary.turnId}
        files={checkpointFiles}
        allDirectoriesExpanded={allDirectoriesExpanded}
        resolvedTheme={resolvedTheme}
        onOpenTurnDiff={onOpenTurnDiff}
      />
    </div>
  );
}

export function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatTimestamp(createdAt, timestampFormat);
  return `${formatTimestamp(createdAt, timestampFormat)} • ${duration}`;
}
