import { memo, useCallback, useState } from "react";
import {
  ArrowUpRightIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  GlobeIcon,
  MousePointer2Icon,
  RotateCwIcon,
  XIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { isElectron } from "~/config/env";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { BrowserPageMetadata } from "./BrowserPanel.viewport";
import { filterBrowserHistory, resolveBrowserHistorySelectionIndex } from "./BrowserPanel.history";

export interface BrowserToolbarProps {
  inputUrl: string;
  setInputUrl: (v: string) => void;
  onNavigate: () => void;
  onSelectHistoryUrl: (url: string) => void;
  onCancelEmptyUrlEdit: () => void;
  onClose: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onReload: () => void;
  onOpenInExternalBrowser: () => void;
  onAnnotate: () => void;
  annotationActive?: boolean;
  pageMetadata: BrowserPageMetadata;
  historyUrls: string[];
  annotationDisabled?: boolean;
}

function getBrowserFallbackLabel(inputUrl: string): string {
  try {
    return new URL(inputUrl).hostname || inputUrl;
  } catch {
    return inputUrl;
  }
}

export const BrowserToolbar = memo(function BrowserToolbar({
  inputUrl,
  setInputUrl,
  onNavigate,
  onSelectHistoryUrl,
  onCancelEmptyUrlEdit,
  onClose,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onReload,
  onOpenInExternalBrowser,
  onAnnotate,
  annotationActive = false,
  pageMetadata,
  historyUrls,
  annotationDisabled = false,
}: BrowserToolbarProps) {
  const [urlFocused, setUrlFocused] = useState(false);
  const [selectedHistoryIndex, setSelectedHistoryIndex] = useState(-1);
  const pageLabel = pageMetadata.title.trim() || getBrowserFallbackLabel(inputUrl);
  const matchingHistoryUrls = urlFocused ? filterBrowserHistory(historyUrls, inputUrl) : [];

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const currentMatchingHistoryUrls = urlFocused
        ? filterBrowserHistory(historyUrls, inputUrl)
        : [];
      if (e.key === "ArrowDown" && currentMatchingHistoryUrls.length > 0) {
        e.preventDefault();
        setSelectedHistoryIndex((index) =>
          resolveBrowserHistorySelectionIndex(index, 1, currentMatchingHistoryUrls.length),
        );
        return;
      }
      if (e.key === "ArrowUp" && currentMatchingHistoryUrls.length > 0) {
        e.preventDefault();
        setSelectedHistoryIndex((index) =>
          resolveBrowserHistorySelectionIndex(index, -1, currentMatchingHistoryUrls.length),
        );
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const selectedUrl = currentMatchingHistoryUrls[selectedHistoryIndex];
        if (selectedUrl) {
          onSelectHistoryUrl(selectedUrl);
          setSelectedHistoryIndex(-1);
          return;
        }
        onNavigate();
      }
    },
    [historyUrls, inputUrl, onNavigate, onSelectHistoryUrl, selectedHistoryIndex, urlFocused],
  );

  const annotateTooltip = annotationDisabled
    ? "Annotation is available in the desktop browser view"
    : "Annotate browser page";

  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-border px-3",
        isElectron ? "h-[52px]" : "py-2",
      )}
    >
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                className="shrink-0 px-1.5"
                onClick={onGoBack}
                disabled={!canGoBack}
                aria-label="Go back"
              >
                <ArrowLeftIcon className="size-4" />
              </Button>
            }
          />
          <TooltipPopup side="bottom">Go back</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                className="shrink-0 px-1.5"
                onClick={onGoForward}
                disabled={!canGoForward}
                aria-label="Go forward"
              >
                <ArrowRightIcon className="size-4" />
              </Button>
            }
          />
          <TooltipPopup side="bottom">Go forward</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                className="shrink-0 px-1.5"
                onClick={onReload}
                aria-label="Reload"
              >
                <RotateCwIcon className="size-4" />
              </Button>
            }
          />
          <TooltipPopup side="bottom">Reload</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                className={cn(
                  "shrink-0 px-1.5",
                  annotationActive &&
                    "bg-secondary text-info-foreground hover:text-info-foreground",
                )}
                onClick={onAnnotate}
                disabled={annotationDisabled}
                aria-label="Annotate browser page"
                data-pressed={annotationActive ? "true" : undefined}
              >
                <MousePointer2Icon className="size-4" />
              </Button>
            }
          />
          <TooltipPopup side="bottom">
            {annotationActive ? "Exit annotation mode" : annotateTooltip}
          </TooltipPopup>
        </Tooltip>
      </div>

      <div className="relative min-w-0 flex-1">
        <input
          type="text"
          value={inputUrl}
          onChange={(e) => {
            setSelectedHistoryIndex(-1);
            setInputUrl(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setUrlFocused(true)}
          onBlur={() => {
            if (!inputUrl.trim()) {
              onCancelEmptyUrlEdit();
            }
            setUrlFocused(false);
            setSelectedHistoryIndex(-1);
          }}
          className={cn(
            "h-8 w-full min-w-0 rounded-lg border border-input bg-background pl-3 pr-10 font-['DM_Sans',-apple-system,BlinkMacSystemFont,'Segoe_UI',system-ui,sans-serif] text-[0.6875rem] tracking-tighter text-foreground outline-none placeholder:text-muted-foreground/72 focus-visible:border-ring/45 dark:bg-input/32",
            !urlFocused && "text-transparent caret-transparent placeholder:text-transparent",
          )}
          placeholder="Enter a URL"
        />
        {!urlFocused && (
          <div className="pointer-events-none absolute inset-0 flex min-w-0 items-center gap-2 pl-3 pr-10 font-['DM_Sans',-apple-system,BlinkMacSystemFont,'Segoe_UI',system-ui,sans-serif] text-[0.6875rem] tracking-tighter text-foreground">
            {pageMetadata.faviconUrl ? (
              <img
                src={pageMetadata.faviconUrl}
                alt=""
                className="size-4 shrink-0 rounded-sm"
                draggable={false}
              />
            ) : (
              <GlobeIcon className="size-4 shrink-0 text-muted-foreground/70" />
            )}
            <span className="min-w-0 truncate">{pageLabel}</span>
          </div>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 px-0"
                onClick={onOpenInExternalBrowser}
                aria-label="Open in default browser"
              >
                <ArrowUpRightIcon className="size-4" />
              </Button>
            }
          />
          <TooltipPopup side="bottom">Open in default browser</TooltipPopup>
        </Tooltip>
        {matchingHistoryUrls.length > 0 && (
          <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-lg">
            {matchingHistoryUrls.map((url, index) => (
              <button
                key={url}
                type="button"
                className={cn(
                  "flex h-7 w-full min-w-0 items-center px-3 text-left font-['DM_Sans',-apple-system,BlinkMacSystemFont,'Segoe_UI',system-ui,sans-serif] text-[0.6875rem] tracking-tighter text-foreground hover:bg-accent",
                  index === selectedHistoryIndex && "bg-accent",
                )}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelectHistoryUrl(url);
                }}
                onMouseEnter={() => setSelectedHistoryIndex(index)}
              >
                <span className="truncate">{url}</span>
              </button>
            ))}
          </div>
        )}
      </div>
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
