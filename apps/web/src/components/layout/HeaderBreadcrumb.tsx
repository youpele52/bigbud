import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

export function HeaderBreadcrumb({
  parent,
  current,
  trailing,
}: {
  readonly parent: string | undefined;
  readonly current: string;
  readonly trailing?: ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
      {parent && (
        <>
          <span className="max-w-[50%] shrink-0 truncate text-foreground" title={parent}>
            {parent}
          </span>
          <ChevronRightIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground/60"
          />
        </>
      )}
      <span className="min-w-0 truncate text-muted-foreground" title={current}>
        {current}
      </span>
      {trailing}
    </span>
  );
}
