import { BotIcon } from "lucide-react";
import { useMemo, useState } from "react";

import ChatMarkdown from "../common/ChatMarkdown";
import { type TimestampFormat } from "@bigbud/contracts/settings";
import { formatTimestamp } from "../../../utils/timestamp";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";
import { Button } from "../../ui/button";
import { cn } from "~/lib/utils";

type ThinkingRow = Extract<MessagesTimelineRow, { kind: "thinking" }>;

const THINKING_COLLAPSE_THRESHOLD = 320;

interface ThinkingMessageBodyProps {
  row: ThinkingRow;
  markdownCwd: string | undefined;
  timestampFormat: TimestampFormat;
}

export function ThinkingMessageBody({
  row,
  markdownCwd,
  timestampFormat,
}: ThinkingMessageBodyProps) {
  const detail = row.entry.detail?.trim() || row.entry.label;
  const title = row.entry.label.trim().length > 0 ? row.entry.label : "Thinking";
  const shouldCollapse = detail.length > THINKING_COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(false);
  const collapsedPreview = useMemo(() => {
    if (!shouldCollapse) {
      return detail;
    }
    return `${detail.slice(0, THINKING_COLLAPSE_THRESHOLD).trimEnd()}\n\n...`;
  }, [detail, shouldCollapse]);
  const renderedDetail = shouldCollapse && !expanded ? collapsedPreview : detail;

  return (
    <div className="min-w-0 px-1 py-0.5">
      <div className="rounded-xl border border-border/40 bg-card/12 px-3 py-2">
        <div className="mb-2 flex items-center gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/55">
            <BotIcon className="size-3" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[10px] uppercase tracking-[0.14em] text-muted-foreground/52">
              {title}
            </p>
          </div>
        </div>
        <div className={cn(shouldCollapse && !expanded && "relative")}>
          <ChatMarkdown
            text={renderedDetail}
            cwd={markdownCwd}
            isStreaming={row.streaming}
            className="thinking-markdown text-xs leading-[1.55] text-muted-foreground/68"
          />
          {shouldCollapse && !expanded && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-t from-background/85 to-transparent" />
          )}
        </div>
        {shouldCollapse && (
          <div className="mt-2 flex justify-start">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="h-auto px-1.5 py-0.5 text-[10px] text-muted-foreground/55"
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? "Collapse thinking" : "Expand thinking"}
            </Button>
          </div>
        )}
        <div className="mt-1.5 flex justify-start">
          <p className="text-[10px] text-muted-foreground/35">
            {formatTimestamp(row.createdAt, timestampFormat)}
          </p>
        </div>
      </div>
    </div>
  );
}
