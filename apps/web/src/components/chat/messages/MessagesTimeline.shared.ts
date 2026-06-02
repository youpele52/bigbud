import { type ExecutionTargetId, type MessageId, type TurnId } from "@bigbud/contracts";
import { type TimestampFormat } from "@bigbud/contracts/settings";

import { type deriveTimelineEntries } from "../../../logic/session";
import { type ExpandedImagePreview } from "../common/ExpandedImagePreview";
import { type TurnDiffSummary } from "../../../models/types";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";

export const MIN_ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;
export const RECENT_COMPLETED_TURNS_TO_KEEP_MOUNTED = 2;

export interface MessagesTimelineProps {
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  scrollContainer: HTMLDivElement | null;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  nowIso: string;
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
  changedFilesExpandedByTurnId: Record<string, boolean>;
  onSetChangedFilesExpanded: (turnId: TurnId, expanded: boolean) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  workspaceExecutionTargetId?: ExecutionTargetId | undefined;
  focusMessageId?: MessageId | null;
  onReplyToMessage?: (messageId: MessageId) => void;
  onOpenReplySource?: (messageId: MessageId) => void;
  onBranchThread?: (messageId: MessageId) => void;
  onVirtualizerSnapshot?: (snapshot: {
    totalSize: number;
    measurements: ReadonlyArray<{
      id: string;
      kind: MessagesTimelineRow["kind"];
      index: number;
      size: number;
      start: number;
      end: number;
    }>;
  }) => void;
}

export interface MessagesTimelineRowContentProps {
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
  workspaceExecutionTargetId?: ExecutionTargetId | undefined;
  isWorking: boolean;
  onTimelineImageLoad: () => void;
  focusedMessageId: MessageId | null;
  onReplyToMessage: (messageId: MessageId) => void;
  onOpenReplySource: (messageId: MessageId) => void;
  onBranchThread?: (messageId: MessageId) => void;
}
