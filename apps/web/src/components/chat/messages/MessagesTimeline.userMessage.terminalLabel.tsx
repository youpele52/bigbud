import { memo } from "react";
import type { ParsedTerminalContextEntry } from "~/lib/terminalContext";
import { TerminalContextInlineChip } from "../terminal/TerminalContextInlineChip";

export const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;
    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);
