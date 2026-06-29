import { XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

interface FilePreviewHeaderProps {
  readonly breadcrumb: ReadonlyArray<{ id: string; label: string }>;
  readonly onBack?: (() => void) | undefined;
  readonly onContextMenu?: ((event: React.MouseEvent<HTMLDivElement>) => void) | undefined;
  readonly actions?: React.ReactNode;
}

export function FilePreviewHeader({
  breadcrumb,
  onBack,
  onContextMenu,
  actions,
}: FilePreviewHeaderProps) {
  return (
    <div
      className="flex items-center gap-2 border-b border-border px-2 py-2"
      onContextMenu={onContextMenu}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1 overflow-hidden text-xs">
          {breadcrumb.map((part, index) => (
            <span key={part.id} className="flex min-w-0 items-center gap-1">
              {index > 0 ? <span className="text-muted-foreground/45">&gt;</span> : null}
              <span
                className={cn(
                  "truncate",
                  index === breadcrumb.length - 1
                    ? "font-medium text-foreground"
                    : "text-muted-foreground/75",
                )}
                title={part.label}
              >
                {part.label}
              </span>
            </span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-8">
        {actions}
        {onBack ? (
          <Button type="button" variant="ghost" size="icon-xs" onClick={onBack} aria-label="Close">
            <XIcon />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
