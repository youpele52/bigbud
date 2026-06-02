import { type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Button } from "../../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";

export interface StructuredAnnotationPreviewItem {
  id: string;
  thumbnail?: ReactNode;
  title: string;
  badge: ReactNode;
  subtitle: string;
  detail: string;
  removeLabel: string;
}

interface StructuredAnnotationPreviewsProps {
  triggerIcon: ReactNode;
  label: string;
  clearLabel: string;
  items: ReadonlyArray<StructuredAnnotationPreviewItem>;
  onRemoveItem: (itemId: string) => void;
  onClear: () => void;
}

export function StructuredAnnotationPreviews(props: StructuredAnnotationPreviewsProps) {
  if (props.items.length === 0) return null;

  return (
    <div className="mb-3 flex flex-wrap gap-2">
      <Popover>
        <div className="group inline-flex items-center gap-1 rounded-lg border border-border/80 bg-background px-1 py-1">
          <PopoverTrigger
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-foreground/80 transition-colors hover:bg-muted/60"
            aria-label={`Show ${props.label}`}
          >
            {props.triggerIcon}
            <span>{props.label}</span>
          </PopoverTrigger>
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0 opacity-60 transition-opacity hover:opacity-100 group-hover:opacity-100"
            onClick={props.onClear}
            aria-label={props.clearLabel}
          >
            <XIcon />
          </Button>
        </div>
        <PopoverPopup align="start" side="top" className="w-[min(420px,calc(100vw-2rem))] p-0">
          <div className="max-h-80 space-y-2 overflow-y-auto p-3">
            {props.items.map((item) => (
              <div
                key={item.id}
                className="group grid grid-cols-[56px_minmax(0,1fr)_auto] gap-3 rounded-lg border border-border/80 bg-background p-2"
              >
                <div className="h-14 w-14 overflow-hidden rounded-md border border-border/70 bg-muted">
                  {item.thumbnail}
                </div>
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-foreground">
                      {item.title}
                    </span>
                    {item.badge}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{item.subtitle}</div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground/80">
                    {item.detail}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={() => props.onRemoveItem(item.id)}
                  aria-label={item.removeLabel}
                >
                  <XIcon />
                </Button>
              </div>
            ))}
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
