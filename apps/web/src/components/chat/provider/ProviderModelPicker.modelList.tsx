import { type ProviderKind } from "@bigbud/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Searchbar } from "../../ui/Searchbar";
import { MenuGroup, MenuGroupLabel, MenuRadioGroup, MenuRadioItem } from "../../ui/menu";
import { Spinner } from "../../ui/spinner";
import { cn } from "~/lib/utils";
import {
  groupModelOptions,
  modelOptionValue,
  type ModelOption,
  visibleModelOptionsForPicker,
} from "./ProviderModelPicker.models";

const INITIAL_VISIBLE_MODEL_COUNT = 10;
const VISIBLE_MODEL_COUNT_INCREMENT = 20;
const VISIBLE_MODEL_LIST_BOTTOM_THRESHOLD_PX = 96;

export function ModelList({
  provider,
  selectedValue,
  options,
  recentOptions,
  loading = false,
  unavailableMessage,
  onSelect,
  onBack,
  searchbarClassName,
  groupLabelClassName,
  itemClassName,
  itemLabelClassName,
}: {
  provider: ProviderKind;
  selectedValue: string;
  options: ReadonlyArray<ModelOption>;
  recentOptions?: ReadonlyArray<ModelOption> | undefined;
  loading?: boolean;
  unavailableMessage?: string | undefined;
  onSelect: (value: string) => void;
  onBack?: () => void;
  searchbarClassName?: string | undefined;
  groupLabelClassName?: string | undefined;
  itemClassName?: string | undefined;
  itemLabelClassName?: string | undefined;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listBodyRef = useRef<HTMLDivElement>(null);
  const hasSearchQuery = query.trim().length > 0;

  const visibleOptions = useMemo(
    () => visibleModelOptionsForPicker(provider, options, recentOptions, query),
    [options, provider, query, recentOptions],
  );
  const filtered = useMemo(() => {
    if (!hasSearchQuery) return visibleOptions;
    const normalizedQuery = query.trim().toLowerCase();
    return visibleOptions.filter(
      (option) =>
        option.name.toLowerCase().includes(normalizedQuery) ||
        option.slug.toLowerCase().includes(normalizedQuery) ||
        option.group?.toLowerCase().includes(normalizedQuery),
    );
  }, [hasSearchQuery, query, visibleOptions]);
  const [visibleModelCount, setVisibleModelCount] = useState(() =>
    Math.min(filtered.length, INITIAL_VISIBLE_MODEL_COUNT),
  );
  const selectedOptionIndex = filtered.findIndex(
    (option) => modelOptionValue(option) === selectedValue,
  );
  const resolvedVisibleModelCount =
    selectedOptionIndex === -1
      ? visibleModelCount
      : Math.max(visibleModelCount, selectedOptionIndex + 1);
  const renderedOptions = filtered.slice(0, resolvedVisibleModelCount);

  const showRecentOptions = Boolean(recentOptions && recentOptions.length > 0 && !hasSearchQuery);
  const grouped = useMemo(() => groupModelOptions(renderedOptions), [renderedOptions]);
  const hasVisibleModels = grouped.length > 0;
  const hasNamedGroups = grouped.some((group) => group.kind === "named");
  const showLoadingState = loading && options.length === 0;
  const showUnavailableState = !loading && Boolean(unavailableMessage) && options.length === 0;
  const showEmptyState =
    !showLoadingState && !showUnavailableState && !hasVisibleModels && !showRecentOptions;
  const hasMoreModelsToRender = resolvedVisibleModelCount < filtered.length;

  const loadMoreModels = () => {
    setVisibleModelCount((current) =>
      Math.min(filtered.length, current + VISIBLE_MODEL_COUNT_INCREMENT),
    );
  };

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setVisibleModelCount(Math.min(filtered.length, INITIAL_VISIBLE_MODEL_COUNT));
  }, [filtered.length, provider, query]);

  return (
    <div className="flex max-h-(--available-height) flex-col">
      <Searchbar
        sticky
        showSearchIcon={false}
        backAriaLabel="Back to provider selection"
        canClear={query.length > 0}
        onClear={() => {
          setQuery("");
          inputRef.current?.focus();
        }}
        onClick={() => {
          inputRef.current?.focus();
        }}
        {...(searchbarClassName ? { className: searchbarClassName } : {})}
        {...(onBack ? { onBack } : {})}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
          }}
          placeholder="Search models"
          className="min-w-0 flex-1 bg-transparent py-0.5 text-[11px] tracking-tight text-foreground placeholder:text-[11px] placeholder:tracking-tight placeholder:text-muted-foreground/50 focus:outline-none"
        />
      </Searchbar>

      <div
        ref={listBodyRef}
        data-testid="provider-model-list-scroll"
        className="min-h-0 max-h-[min(14rem,var(--available-height))] flex-1 overflow-y-auto"
        onScroll={(event) => {
          const currentTarget = event.currentTarget;
          if (
            hasMoreModelsToRender &&
            currentTarget.scrollTop + currentTarget.clientHeight >=
              currentTarget.scrollHeight - VISIBLE_MODEL_LIST_BOTTOM_THRESHOLD_PX
          ) {
            loadMoreModels();
          }
        }}
      >
        <MenuRadioGroup value={selectedValue} onValueChange={onSelect}>
          {showLoadingState ? (
            <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground/70">
              <Spinner className="size-3" />
              <span>Loading models...</span>
            </div>
          ) : null}
          {showUnavailableState ? (
            <div className="px-3 py-4 text-center text-sm text-muted-foreground/70">
              {unavailableMessage}
            </div>
          ) : null}
          {showRecentOptions && recentOptions ? (
            <MenuGroup>
              <MenuGroupLabel className={groupLabelClassName}>Recently used</MenuGroupLabel>
              {recentOptions.map((modelOption) => (
                <MenuRadioItem
                  className={itemClassName}
                  key={`recent:${provider}:${modelOptionValue(modelOption)}`}
                  value={modelOptionValue(modelOption)}
                >
                  <span className={cn("min-w-0", itemLabelClassName)}>{modelOption.name}</span>
                </MenuRadioItem>
              ))}
            </MenuGroup>
          ) : null}
          {showEmptyState ? (
            <div className="px-3 py-4 text-center text-sm text-muted-foreground/60">
              {hasSearchQuery ? `No models match “${query}”` : "No models available"}
            </div>
          ) : hasNamedGroups ? (
            grouped.map((section) => (
              <MenuGroup key={section.kind === "named" ? section.group : "__ungrouped"}>
                {section.kind === "named" ? (
                  <MenuGroupLabel className={groupLabelClassName}>{section.group}</MenuGroupLabel>
                ) : null}
                {section.models.map((modelOption) => (
                  <MenuRadioItem
                    className={itemClassName}
                    key={`${provider}:${modelOptionValue(modelOption)}`}
                    value={modelOptionValue(modelOption)}
                  >
                    <span className={cn("min-w-0", itemLabelClassName)}>{modelOption.name}</span>
                  </MenuRadioItem>
                ))}
              </MenuGroup>
            ))
          ) : hasVisibleModels ? (
            <MenuGroup>
              {renderedOptions.map((modelOption) => (
                <MenuRadioItem
                  className={itemClassName}
                  key={`${provider}:${modelOptionValue(modelOption)}`}
                  value={modelOptionValue(modelOption)}
                >
                  <span className={cn("min-w-0", itemLabelClassName)}>{modelOption.name}</span>
                </MenuRadioItem>
              ))}
            </MenuGroup>
          ) : null}
        </MenuRadioGroup>
      </div>
    </div>
  );
}
