import type { ReactNode } from "react";

import { textButtonTypography } from "../../ui/button";
import { ActivityOverflowToggle, type ActivityOverflowState } from "./ActivityOverflowToggle";

export function CompactActivityGroup(props: {
  label: string;
  count: number;
  children: ReactNode;
  showHeader?: boolean;
  overflow?: ActivityOverflowState | undefined;
}) {
  return (
    <div className="w-full rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
      {props.showHeader !== false ? (
        <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
          <p className={textButtonTypography}>
            {props.label} ({props.count})
          </p>
          {props.overflow ? <ActivityOverflowToggle {...props.overflow} /> : null}
        </div>
      ) : null}
      {props.children}
    </div>
  );
}
