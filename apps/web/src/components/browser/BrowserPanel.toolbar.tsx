import {
  DEFAULT_BROWSER_SEARCH_ENGINE,
  type BrowserSearchEngine,
} from "@bigbud/contracts/constants/browser.constant.ts";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useDebouncedValue } from "@tanstack/react-pacer";
import {
  ArrowUpRightIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  MousePointer2Icon,
  RotateCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { isElectron } from "~/config/env";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { BrowserPageMetadata } from "./BrowserPanel.viewport";
import { BrowserFaviconIcon } from "./BrowserPanel.faviconIcon";
import { getBrowserFaviconUrl, getBrowserSuggestions } from "./BrowserPanel.suggestions";
import { buildBrowserSearchUrl, resolveBrowserOmniboxInput } from "./BrowserPanel.omnibox";
import {
  type BrowserVisitRecord,
  resolveBrowserHistorySelectionIndex,
} from "./BrowserPanel.history";

export interface BrowserToolbarProps {
  inputUrl: string;
  pageUrl?: string;
  searchEngine?: BrowserSearchEngine;
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
  annotationActive?: boolean;
  pageMetadata: BrowserPageMetadata;
  pageMetadataUrl?: string | null;
  historyUrls: BrowserVisitRecord[];
  annotationDisabled?: boolean;
  agentControlled?: boolean;
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
  pageUrl = inputUrl,
  searchEngine = DEFAULT_BROWSER_SEARCH_ENGINE,
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
  annotationActive = false,
  pageMetadata,
  pageMetadataUrl = null,
  historyUrls,
  annotationDisabled = false,
  agentControlled = false,
  loading = false,
  canStopLoading = true,
}: BrowserToolbarProps) {
  const [addressBarHovered, setAddressBarHovered] = useState(false);
  const [urlFocused, setUrlFocused] = useState(false);
  const [selectedHistoryIndex, setSelectedHistoryIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const [debouncedInputUrl] = useDebouncedValue(inputUrl, { wait: 250 });
  const pageLabel = pageMetadata.title.trim() || getBrowserFallbackLabel(inputUrl);
  const isAddressBarExpanded = urlFocused || addressBarHovered || inputUrl.trim().length === 0;
  const suggestions = useMemo(
    () => (urlFocused ? getBrowserSuggestions(historyUrls, inputUrl, searchEngine) : []),
    [historyUrls, inputUrl, searchEngine, urlFocused],
  );
  const addressUrl = urlFocused ? resolveBrowserOmniboxInput(inputUrl, searchEngine) : pageUrl;
  const isSearch =
    urlFocused &&
    Boolean(inputUrl.trim()) &&
    addressUrl === buildBrowserSearchUrl(inputUrl.trim(), searchEngine);
  const observedPage = { url: pageMetadataUrl, faviconUrl: pageMetadata.faviconUrl };
  const allowFaviconFallback = !urlFocused || debouncedInputUrl === inputUrl;
  const faviconUrl = isSearch
    ? null
    : getBrowserFaviconUrl(addressUrl ?? "", historyUrls, observedPage, allowFaviconFallback);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown" && suggestions.length > 0) {
        e.preventDefault();
        setSelectedHistoryIndex((index) =>
          resolveBrowserHistorySelectionIndex(index, 1, suggestions.length),
        );
        return;
      }
      if (e.key === "ArrowUp" && suggestions.length > 0) {
        e.preventDefault();
        setSelectedHistoryIndex((index) =>
          resolveBrowserHistorySelectionIndex(index, -1, suggestions.length),
        );
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const selected = suggestions[selectedHistoryIndex];
        if (selected) {
          onSelectHistoryUrl(selected.url);
          setSelectedHistoryIndex(-1);
          return;
        }
        onNavigate();
      }
    },
    [onNavigate, onSelectHistoryUrl, selectedHistoryIndex, suggestions],
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
      </div>

      <div
        className="relative min-w-0 flex-1"
        onMouseEnter={() => setAddressBarHovered(true)}
        onMouseLeave={() => setAddressBarHovered(false)}
      >
        <span
          className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2"
          data-browser-address-icon="true"
        >
          {isSearch ? (
            <SearchIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
          ) : (
            <BrowserFaviconIcon key={faviconUrl} faviconUrl={faviconUrl} />
          )}
        </span>
        <input
          ref={inputRef}
          data-browser-omnibox="true"
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
            "h-8 w-full min-w-0 rounded-lg border pl-9 pr-10 text-left font-['DM_Sans',-apple-system,BlinkMacSystemFont,'Segoe_UI',system-ui,sans-serif] text-[0.6875rem] tracking-tighter text-foreground outline-none placeholder:text-muted-foreground/72 focus-visible:border-ring/45",
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
        {suggestions.length > 0 && (
          <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-lg">
            {suggestions.map((suggestion, index) => (
              <button
                key={`${suggestion.kind}:${suggestion.url}`}
                data-browser-suggestion={suggestion.kind}
                type="button"
                className={cn(
                  "flex h-7 w-full min-w-0 items-center gap-2 px-3 text-left font-['DM_Sans',-apple-system,BlinkMacSystemFont,'Segoe_UI',system-ui,sans-serif] text-[0.6875rem] tracking-tighter text-foreground hover:bg-accent",
                  index === selectedHistoryIndex && "bg-accent",
                )}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelectHistoryUrl(suggestion.url);
                  inputRef.current?.blur();
                }}
                onMouseEnter={() => setSelectedHistoryIndex(index)}
              >
                {suggestion.kind === "search" ? (
                  <SearchIcon
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                ) : (
                  <BrowserFaviconIcon
                    faviconUrl={getBrowserFaviconUrl(
                      suggestion.url,
                      historyUrls,
                      observedPage,
                      allowFaviconFallback,
                    )}
                  />
                )}
                <span className="truncate">{suggestion.label}</span>
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
