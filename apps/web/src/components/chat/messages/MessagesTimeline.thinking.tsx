import ChatMarkdown from "../common/ChatMarkdown";
import { type TimestampFormat } from "@bigbud/contracts/settings";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";
import { ActivityAccordion } from "../common/ActivityAccordion";
import type { ActivityAccordionControl } from "../common/ActivityAccordion.state";
import { ActivityAccordionTime } from "../common/ActivityAccordionTime";
import type { MarkdownAnchorClick } from "../../common/BaseMarkdown";

type ThinkingRow = Extract<MessagesTimelineRow, { kind: "thinking" }>;

interface ThinkingMessageBodyProps {
  row: ThinkingRow;
  markdownCwd: string | undefined;
  onMarkdownAnchorClick?: ((input: MarkdownAnchorClick) => void) | undefined;
  timestampFormat: TimestampFormat;
  /** Persisted open state: open while streaming, collapsed once finished unless toggled. */
  accordion?: ActivityAccordionControl | undefined;
}

export function ThinkingMessageBody({
  row,
  markdownCwd,
  onMarkdownAnchorClick,
  timestampFormat,
  accordion,
}: ThinkingMessageBodyProps) {
  const detail = row.entry.detail?.trim() || row.entry.label;
  const title = row.entry.label.trim().length > 0 ? row.entry.label : "Thinking";

  return (
    <div className="min-w-0 py-0.5">
      <ActivityAccordion
        title={title}
        meta={<ActivityAccordionTime dateTime={row.createdAt} timestampFormat={timestampFormat} />}
        {...accordion}
      >
        <ChatMarkdown
          text={detail}
          cwd={markdownCwd}
          isStreaming={row.streaming}
          onAnchorClick={onMarkdownAnchorClick}
          className="thinking-markdown text-xs leading-[1.55] text-muted-foreground/68"
        />
      </ActivityAccordion>
    </div>
  );
}
