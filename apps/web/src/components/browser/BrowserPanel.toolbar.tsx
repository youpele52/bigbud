import { memo, useCallback, useState } from "react";
import {
  ArrowUpRightIcon,
  BookmarkIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  MousePointer2Icon,
  RotateCwIcon,
  XIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { isElectron } from "~/config/env";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { BrowserPageMetadata } from "./BrowserPanel.viewport";
import {
  type BrowserVisitRecord,
  filterBrowserHistory,
  resolveBrowserHistorySelectionIndex,
} from "./BrowserPanel.history";

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
  onStopLoading: () => void;
  onOpenInExternalBrowser: () => void;
  onAnnotate: () => void;
  onToggleBookmark?: (() => void) | undefined;
  annotationActive?: boolean;
  pageMetadata: BrowserPageMetadata;
  historyUrls: BrowserVisitRecord[];
  annotationDisabled?: boolean;
  agentControlled?: boolean;
  bookmarked?: boolean;
  loading?: boolean;
  canStopLoading?: boolean;
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
  onStopLoading,
  onOpenInExternalBrowser,
  onAnnotate,
  onToggleBookmark,
  annotationActive = false,
  pageMetadata,
  historyUrls,
  annotationDisabled = false,
  agentControlled = false,
  bookmarked = false,
  loading = false,
  canStopLoading = true,
}: BrowserToolbarProps) {
  const [addressBarHovered, setAddressBarHovered] = useState(false);
  const [urlFocused, setUrlFocused] = useState(false);
  const [selectedHistoryIndex, setSelectedHistoryIndex] = useState(-1);
  const pageLabel = pageMetadata.title.trim() || getBrowserFallbackLabel(inputUrl);
  const isAddressBarExpanded = urlFocused || addressBarHovered || inputUrl.trim().length === 0;
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
                disabled={!canGoBack || agentControlled}
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
                disabled={!canGoForward || agentControlled}
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
                onClick={loading && canStopLoading ? onStopLoading : onReload}
                disabled={agentControlled}
                aria-label={loading && canStopLoading ? "Stop loading" : "Reload"}
              >
                {loading && canStopLoading ? (
                  <XIcon className="size-4" />
                ) : (
                  <RotateCwIcon className="size-4" />
                )}
              </Button>
            }
          />
          <TooltipPopup side="bottom">
            {loading && canStopLoading ? "Stop loading" : "Reload"}
          </TooltipPopup>
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
                disabled={annotationDisabled || agentControlled}
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
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                className="shrink-0 px-1.5"
                onClick={onToggleBookmark}
                disabled={!onToggleBookmark || agentControlled}
                aria-label={bookmarked ? "Remove bookmark" : "Add bookmark"}
                data-pressed={bookmarked ? "true" : undefined}
              >
                <BookmarkIcon className="size-4" fill={bookmarked ? "currentColor" : "none"} />
              </Button>
            }
          />
          <TooltipPopup side="bottom">
            {bookmarked ? "Remove bookmark" : "Add bookmark"}
          </TooltipPopup>
        </Tooltip>
      </div>

      <div
        className="relative min-w-0 flex-1"
        onMouseEnter={() => setAddressBarHovered(true)}
        onMouseLeave={() => setAddressBarHovered(false)}
      >
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
          disabled={agentControlled}
          className={cn(
            "h-8 w-full min-w-0 rounded-lg border px-3 pr-10 text-left font-['DM_Sans',-apple-system,BlinkMacSystemFont,'Segoe_UI',system-ui,sans-serif] text-[0.6875rem] tracking-tighter text-foreground outline-none placeholder:text-muted-foreground/72 focus-visible:border-ring/45",
            isAddressBarExpanded
              ? "border-input bg-background dark:bg-input/32"
              : "border-transparent bg-transparent",
            !urlFocused &&
              inputUrl.trim().length > 0 &&
              "text-transparent caret-transparent placeholder:text-transparent",
          )}
          placeholder="Enter a URL or search"
        />
        {!urlFocused && inputUrl.trim().length > 0 && (
          <div className="pointer-events-none absolute inset-0 flex min-w-0 items-center justify-center px-10 font-['DM_Sans',-apple-system,BlinkMacSystemFont,'Segoe_UI',system-ui,sans-serif] text-[0.6875rem] tracking-tighter text-foreground">
            <span className="min-w-0 truncate">{pageLabel}</span>
          </div>
        )}
        {addressBarHovered && !urlFocused ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 px-0"
                  onClick={onOpenInExternalBrowser}
                  disabled={agentControlled}
                  aria-label="Open in default browser"
                >
                  <ArrowUpRightIcon className="size-4" />
                </Button>
              }
            />
            <TooltipPopup side="bottom">Open in default browser</TooltipPopup>
          </Tooltip>
        ) : null}
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
