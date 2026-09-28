import type { ReactNode } from "react";

import { Button, textButtonTypography } from "../../ui/button";

export function CompactActivityGroup(props: {
  label: string;
  count: number;
  children: ReactNode;
  showHeader?: boolean;
  overflow?:
    | {
        expanded: boolean;
        hiddenCount: number;
        onToggle: () => void;
      }
    | undefined;
}) {
  return (
    <div className="w-full rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
      {props.showHeader !== false ? (
        <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
          <p className={textButtonTypography}>
            {props.label} ({props.count})
          </p>
          {props.overflow ? (
            <Button
              size="xs"
              variant="text"
              type="button"
              aria-expanded={props.overflow.expanded}
              onClick={props.overflow.onToggle}
            >
              {props.overflow.expanded ? "Show less" : `Show ${props.overflow.hiddenCount} more`}
            </Button>
          ) : null}
        </div>
      ) : null}
      {props.children}
    </div>
  );
}
