import { memo, useCallback } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  MousePointer2Icon,
  RotateCwIcon,
  XIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { isElectron } from "~/config/env";
import { Button } from "../ui/button";

export interface BrowserToolbarProps {
  inputUrl: string;
  setInputUrl: (v: string) => void;
  onNavigate: () => void;
  onClose: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onReload: () => void;
  onAnnotate: () => void;
  annotationDisabled?: boolean;
}

export const BrowserToolbar = memo(function BrowserToolbar({
  inputUrl,
  setInputUrl,
  onNavigate,
  onClose,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onReload,
  onAnnotate,
  annotationDisabled = false,
}: BrowserToolbarProps) {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onNavigate();
      }
    },
    [onNavigate],
  );

  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-border px-3",
        isElectron ? "h-[52px]" : "py-2",
      )}
    >
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0 px-1.5"
          onClick={onGoBack}
          disabled={!canGoBack}
          aria-label="Go back"
          title="Go back"
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0 px-1.5"
          onClick={onGoForward}
          disabled={!canGoForward}
          aria-label="Go forward"
          title="Go forward"
        >
          <ArrowRightIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0 px-1.5"
          onClick={onReload}
          aria-label="Reload"
          title="Reload"
        >
          <RotateCwIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0 px-1.5"
          onClick={onAnnotate}
          disabled={annotationDisabled}
          aria-label="Annotate browser page"
          title={
            annotationDisabled
              ? "Annotation is available in the desktop browser view"
              : "Annotate browser page"
          }
        >
          <MousePointer2Icon className="size-4" />
        </Button>
      </div>

      <input
        type="text"
        value={inputUrl}
        onChange={(e) => setInputUrl(e.target.value)}
        onKeyDown={handleKeyDown}
        className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 font-['DM_Sans',-apple-system,BlinkMacSystemFont,'Segoe_UI',system-ui,sans-serif] text-[0.6875rem] tracking-tighter text-foreground outline-none placeholder:text-muted-foreground/72 focus-visible:border-ring/45 dark:bg-input/32"
        placeholder="Enter a URL"
      />
      <Button
        variant="ghost"
        size="xs"
        className="shrink-0 px-2"
        onClick={onClose}
        aria-label="Close browser panel"
      >
        <XIcon className="size-3" />
      </Button>
    </div>
  );
});
