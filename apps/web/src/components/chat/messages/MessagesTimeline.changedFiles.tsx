import type { MessageId, TurnId } from "@bigbud/contracts";
import { type TurnDiffSummary } from "../../../models/types";
import { summarizeTurnDiffStats } from "../../../lib/turnDiffTree";
import { ActivityAccordion } from "../common/ActivityAccordion";
import type {
  ActivityAccordionOpenById,
  SetActivityAccordionOpen,
} from "../common/ActivityAccordion.state";
import { Button } from "../../ui/button";
import { DiffStatLabel, hasNonZeroStat } from "../diff-display/DiffStatLabel";
import { ChangedFilesTree } from "../diff-display/ChangedFilesTree";
import { changedFilesAccordionControl } from "./MessagesTimeline.accordion";

interface AssistantTurnChangedFilesProps {
  messageId: MessageId;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  changedFilesExpandedByTurnId: Record<string, boolean>;
  onSetChangedFilesExpanded: (turnId: TurnId, expanded: boolean) => void;
  activityAccordionOpenById: ActivityAccordionOpenById;
  onSetActivityAccordionOpen: SetActivityAccordionOpen;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  resolvedTheme: "light" | "dark";
}

/**
 * A turn's changed files as a collapsed activity accordion: the header always shows the
 * file count and line totals, and opening it reveals the directory tree with its actions.
 */
export function AssistantTurnChangedFiles({
  messageId,
  turnDiffSummaryByAssistantMessageId,
  changedFilesExpandedByTurnId,
  onSetChangedFilesExpanded,
  activityAccordionOpenById,
  onSetActivityAccordionOpen,
  onOpenTurnDiff,
  resolvedTheme,
}: AssistantTurnChangedFilesProps) {
  const turnSummary = turnDiffSummaryByAssistantMessageId.get(messageId);
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;

  const summaryStat = summarizeTurnDiffStats(checkpointFiles);
  const allDirectoriesExpanded = changedFilesExpandedByTurnId[turnSummary.turnId] ?? false;
  const accordion = changedFilesAccordionControl(
    turnSummary.turnId,
    activityAccordionOpenById,
    onSetActivityAccordionOpen,
  );

  return (
    <ActivityAccordion
      className="mt-2"
      title={`Changed files (${checkpointFiles.length})`}
      meta={
        hasNonZeroStat(summaryStat) ? (
          <>
            <span className="mr-1.5">•</span>
            <DiffStatLabel additions={summaryStat.additions} deletions={summaryStat.deletions} />
          </>
        ) : undefined
      }
      actions={
        <div className="flex items-center gap-1.5">
          <Button
            size="xs"
            variant="text"
            type="button"
            data-scroll-anchor-ignore
            onClick={() => onSetChangedFilesExpanded(turnSummary.turnId, !allDirectoriesExpanded)}
          >
            {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
          </Button>
          <Button
            size="xs"
            variant="text"
            type="button"
            onClick={() => onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path)}
          >
            View diff
          </Button>
        </div>
      }
      {...accordion}
    >
      <ChangedFilesTree
        key={`changed-files-tree:${turnSummary.turnId}`}
        turnId={turnSummary.turnId}
        files={checkpointFiles}
        allDirectoriesExpanded={allDirectoriesExpanded}
        resolvedTheme={resolvedTheme}
        onOpenTurnDiff={onOpenTurnDiff}
      />
    </ActivityAccordion>
  );
}
