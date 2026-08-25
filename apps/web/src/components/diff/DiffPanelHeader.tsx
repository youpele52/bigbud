import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  Rows3Icon,
  TextWrapIcon,
  XIcon,
} from "lucide-react";
import type { TurnId } from "@bigbud/contracts/core/baseSchemas";

import { cn } from "~/lib/utils";
import { formatShortTimestamp } from "../../utils/timestamp";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import type { DiffRenderMode } from "./DiffPanel.logic";

interface DiffPanelHeaderProps {
  readonly canScrollTurnStripLeft: boolean;
  readonly canScrollTurnStripRight: boolean;
  readonly diffRenderMode: DiffRenderMode;
  readonly diffWordWrap: boolean;
  readonly inferredCheckpointTurnCountByTurnId: Record<string, number | undefined>;
  readonly onClose: () => void;
  readonly onDiffRenderModeChange: (mode: DiffRenderMode) => void;
  readonly onDiffWordWrapChange: (wordWrap: boolean) => void;
  readonly onSelectTurn: (turnId: TurnId) => void;
  readonly onSelectWholeConversation: () => void;
  readonly onTurnStripWheel: (event: React.WheelEvent<HTMLDivElement>) => void;
  readonly orderedTurnDiffSummaries: ReadonlyArray<{
    readonly turnId: TurnId;
    readonly checkpointTurnCount?: number | undefined;
    readonly completedAt: string;
  }>;
  readonly scrollTurnStripBy: (amount: number) => void;
  readonly selectedTurnId: string | null;
  readonly timestampFormat: Parameters<typeof formatShortTimestamp>[1];
  readonly turnStripRef: React.RefObject<HTMLDivElement | null>;
}

export function DiffPanelHeader({
  canScrollTurnStripLeft,
  canScrollTurnStripRight,
  diffRenderMode,
  diffWordWrap,
  inferredCheckpointTurnCountByTurnId,
  onClose,
  onDiffRenderModeChange,
  onDiffWordWrapChange,
  onSelectTurn,
  onSelectWholeConversation,
  onTurnStripWheel,
  orderedTurnDiffSummaries,
  scrollTurnStripBy,
  selectedTurnId,
  timestampFormat,
  turnStripRef,
}: DiffPanelHeaderProps) {
  return (
    <>
      <div className="relative min-w-0 flex-1 [-webkit-app-region:no-drag]">
        <button
          type="button"
          className={cn(
            "absolute left-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
            canScrollTurnStripLeft
              ? "border-border/70 hover:border-border hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={() => scrollTurnStripBy(-180)}
          disabled={!canScrollTurnStripLeft}
          aria-label="Scroll turn list left"
        >
          <ChevronLeftIcon className="size-3.5" />
        </button>
        <button
          type="button"
          className={cn(
            "absolute right-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
            canScrollTurnStripRight
              ? "border-border/70 hover:border-border hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={() => scrollTurnStripBy(180)}
          disabled={!canScrollTurnStripRight}
          aria-label="Scroll turn list right"
        >
          <ChevronRightIcon className="size-3.5" />
        </button>
        <div
          ref={turnStripRef}
          className="turn-chip-strip flex gap-1 overflow-x-auto px-6 py-0.5"
          style={
            canScrollTurnStripLeft || canScrollTurnStripRight
              ? {
                  maskImage: `linear-gradient(to right, ${canScrollTurnStripLeft ? "transparent 24px, black 72px" : "black"}, ${canScrollTurnStripRight ? "black calc(100% - 72px), transparent calc(100% - 24px)" : "black"})`,
                }
              : undefined
          }
          onWheel={onTurnStripWheel}
        >
          <button
            type="button"
            className="shrink-0 rounded-md"
            onClick={onSelectWholeConversation}
            data-turn-chip-selected={selectedTurnId === null}
          >
            <div
              className={cn(
                "rounded-md border px-2 py-1 text-left transition-colors",
                selectedTurnId === null
                  ? "border-border bg-accent text-accent-foreground"
                  : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
              )}
            >
              <div className="text-[10px] leading-tight font-medium">All turns</div>
            </div>
          </button>
          {orderedTurnDiffSummaries.map((summary) => (
            <button
              key={summary.turnId}
              type="button"
              className="shrink-0 rounded-md"
              onClick={() => onSelectTurn(summary.turnId)}
              title={summary.turnId}
              data-turn-chip-selected={summary.turnId === selectedTurnId}
            >
              <div
                className={cn(
                  "rounded-md border px-2 py-1 text-left transition-colors",
                  summary.turnId === selectedTurnId
                    ? "border-border bg-accent text-accent-foreground"
                    : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
                )}
              >
                <div className="flex items-center gap-1">
                  <span className="text-[10px] leading-tight font-medium">
                    Turn{" "}
                    {summary.checkpointTurnCount ??
                      inferredCheckpointTurnCountByTurnId[summary.turnId] ??
                      "?"}
                  </span>
                  <span className="text-[9px] leading-tight opacity-70">
                    {formatShortTimestamp(summary.completedAt, timestampFormat)}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <ToggleGroup
          className="shrink-0"
          variant="toolbar"
          size="xs"
          value={[diffRenderMode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "stacked" || next === "split") onDiffRenderModeChange(next);
          }}
        >
          <Toggle aria-label="Stacked diff view" value="stacked">
            <Rows3Icon className="size-3" />
          </Toggle>
          <Toggle aria-label="Split diff view" value="split">
            <Columns2Icon className="size-3" />
          </Toggle>
        </ToggleGroup>
        <Toggle
          aria-label={diffWordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
          title={diffWordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          variant="toolbar"
          size="xs"
          pressed={diffWordWrap}
          onPressedChange={onDiffWordWrapChange}
        >
          <TextWrapIcon className="size-3" />
        </Toggle>
        <Button variant="toolbar" size="icon-xs" onClick={onClose} aria-label="Close diff panel">
          <XIcon className="size-3" />
        </Button>
      </div>
    </>
  );
}
