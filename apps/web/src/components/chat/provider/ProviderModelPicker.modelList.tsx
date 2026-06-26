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

  const showRecentOptions = Boolean(recentOptions && recentOptions.length > 0 && !hasSearchQuery);
  const grouped = useMemo(() => groupModelOptions(filtered), [filtered]);
  const hasVisibleModels = grouped.length > 0;
  const hasNamedGroups = grouped.some((group) => group.kind === "named");
  const showLoadingState = loading && options.length === 0;
  const showUnavailableState = !loading && Boolean(unavailableMessage) && options.length === 0;
  const showEmptyState =
    !showLoadingState && !showUnavailableState && !hasVisibleModels && !showRecentOptions;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="flex flex-col">
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
            {filtered.map((modelOption) => (
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
  );
}
