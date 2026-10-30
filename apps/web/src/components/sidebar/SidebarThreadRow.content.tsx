import type { ReactNode } from "react";

/** Ìtútù aligns its location beneath the title; Projects keeps its single-line layout. */
export function SidebarThreadRowContent({
  hasProviderIcon,
  firstLine,
  secondaryLine,
}: {
  hasProviderIcon: boolean;
  firstLine: ReactNode;
  secondaryLine?: ReactNode;
}) {
  if (!secondaryLine) return firstLine;

  return (
    <div className="group/thread-row-content flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-2">{firstLine}</div>
      {/* Each provider uses a size-3 icon plus the title row's gap-1.5. */}
      <div
        className={
          hasProviderIcon
            ? "min-w-0 pl-4.5 group-has-[[data-slot=thread-terminal-provider-icon]]/thread-row-content:pl-9"
            : "min-w-0 group-has-[[data-slot=thread-terminal-provider-icon]]/thread-row-content:pl-4.5"
        }
      >
        {secondaryLine}
      </div>
    </div>
  );
}
