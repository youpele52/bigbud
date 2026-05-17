import { type VirtualItem } from "@tanstack/react-virtual";

import { MessagesTimelineRowContent } from "./MessagesTimeline.rows";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";
import { type MessagesTimelineRowContentProps } from "./MessagesTimeline.shared";

interface MessagesTimelineRowsProps extends Omit<MessagesTimelineRowContentProps, "row"> {
  rows: ReadonlyArray<MessagesTimelineRow>;
}

export function renderMessagesTimelineRow(
  row: MessagesTimelineRow,
  props: Omit<MessagesTimelineRowContentProps, "row">,
) {
  return <MessagesTimelineRowContent row={row} {...props} />;
}

export function VirtualizedMessagesTimelineRows({
  rows,
  virtualRows,
  measureElement,
  ...rowProps
}: MessagesTimelineRowsProps & {
  virtualRows: ReadonlyArray<VirtualItem>;
  measureElement: (element: Element | null) => void;
}) {
  return virtualRows.map((virtualRow) => {
    const row = rows[virtualRow.index];
    if (!row) return null;

    return (
      <div
        key={`virtual-row:${row.id}`}
        data-index={virtualRow.index}
        data-virtual-row-id={row.id}
        data-virtual-row-kind={row.kind}
        data-virtual-row-size={virtualRow.size}
        data-virtual-row-start={virtualRow.start}
        ref={measureElement}
        className="absolute left-0 top-0 w-full"
        style={{ transform: `translateY(${virtualRow.start}px)` }}
      >
        {renderMessagesTimelineRow(row, rowProps)}
      </div>
    );
  });
}

export function NonVirtualizedMessagesTimelineRows({
  rows,
  ...rowProps
}: MessagesTimelineRowsProps) {
  return rows.map((row) => (
    <div key={`non-virtual-row:${row.id}`}>{renderMessagesTimelineRow(row, rowProps)}</div>
  ));
}
