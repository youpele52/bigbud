import type { MessageId, TurnId } from "@bigbud/contracts";
import { SplitIcon, TerminalIcon } from "lucide-react";
import { stableVerbFromId } from "../../../utils/copy";
import { formatElapsed } from "../../../logic/session";
import { type TurnDiffSummary } from "../../../models/types";
import { summarizeTurnDiffStats } from "../../../lib/turnDiffTree";
import ChatMarkdown from "../common/ChatMarkdown";
import { Button } from "../../ui/button";
import { ScrollArea } from "../../ui/scroll-area";
import { MessageCopyButton } from "../common/MessageCopyButton";
import { DiffStatLabel, hasNonZeroStat } from "../diff-display/DiffStatLabel";
import { ChangedFilesTree } from "../diff-display/ChangedFilesTree";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { type TimestampFormat } from "@bigbud/contracts/settings";
import { useMemo } from "react";
import { useSettings } from "../../../hooks/useSettings";
import { terminalFontFamilyFromSettings } from "../../terminal/terminalTypography";

import { formatMessageMeta } from "./MessagesTimeline.assistantMessage.meta";

const SHELL_OUTPUT_MAX_HEIGHT = "280px";
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
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  nowIso: string;
  timestampFormat: TimestampFormat;
  onForkThread: (() => void) | undefined;
}

function ShellOutputCard(props: {
  messageText: string;
  terminalTypography: { fontFamily: string; fontSize: number };
}) {
  const { messageText, terminalTypography } = props;

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
        <TerminalIcon className="size-3 shrink-0" />
        <span>Shell</span>
      </div>
      <ScrollArea
        scrollbarGutter
        className="h-auto w-auto max-w-full rounded-md"
        style={{
          maxHeight: SHELL_OUTPUT_MAX_HEIGHT,
          maxWidth: `min(100%, ${SHELL_OUTPUT_MAX_WIDTH})`,
        }}
      >
        <pre
          className="m-0 min-w-full whitespace-pre text-foreground/95"
          style={{
            width: "max-content",
            fontFamily: terminalTypography.fontFamily,
            fontSize: `${terminalTypography.fontSize}px`,
            lineHeight: 1.2,
          }}
        >
          {messageText}
        </pre>
      </ScrollArea>
    </div>
  );
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
  onForkThread,
}: AssistantMessageBodyProps) {
  const messageText =
    row.message.text || (row.message.streaming ? "" : `(${stableVerbFromId(row.message.id)}...)`);
  const shellOutputMessage = isShellOutputMessage(row);
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
            {completionSummary ? `Response • ${completionSummary}` : "Response"}
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>
      )}
      <div className="group min-w-0 px-1 py-0.5">
        {shellOutputMessage ? (
          <ShellOutputCard messageText={messageText} terminalTypography={terminalTypography} />
        ) : (
          <ChatMarkdown
            text={messageText}
            cwd={markdownCwd}
            isStreaming={Boolean(row.message.streaming)}
          />
        )}
        <AssistantTurnDiffCard
          messageId={row.message.id}
          turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
          changedFilesExpandedByTurnId={changedFilesExpandedByTurnId}
          onSetChangedFilesExpanded={onSetChangedFilesExpanded}
          onOpenTurnDiff={onOpenTurnDiff}
          resolvedTheme={resolvedTheme}
        />
        <div className="mt-1.5 flex justify-start">
          <div className="flex min-w-0 items-center gap-2 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
            {row.showAssistantCopyButton && messageText.length > 0 ? (
              <MessageCopyButton text={messageText} />
            ) : null}
            {row.showAssistantCopyButton && onForkThread ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={onForkThread}
                title="Fork thread"
                aria-label="Fork thread"
              >
                <SplitIcon className="size-3" />
              </Button>
            ) : null}
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
