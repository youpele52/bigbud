import { type ProviderKind } from "@bigbud/contracts";
import { useMemo, useRef, useState, type ComponentProps } from "react";
import { useIncrementalList } from "~/hooks/useIncrementalList";
import { SearchableMenuList } from "../../ui/SearchableMenuList";
import { MenuGroup, MenuGroupLabel, MenuRadioGroup, MenuRadioItem } from "../../ui/menu";
import { Spinner } from "../../ui/spinner";
import { Button } from "../../ui/button";
import { OpenCodeSetupMenuItem } from "./ProviderModelPicker.setup";
import { cn } from "~/lib/utils";
import {
  groupModelOptions,
  modelOptionValue,
  type ModelOption,
  visibleModelOptionsForPicker,
} from "./ProviderModelPicker.models";

const INITIAL_VISIBLE_MODEL_COUNT = 5;
const VISIBLE_MODEL_COUNT_INCREMENT = 20;

export function ModelList({
  provider,
  selectedValue,
  options,
  recentOptions,
  loading = false,
  unavailableMessage,
  allowOpenCodeSetup = false,
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
  allowOpenCodeSetup?: boolean;
  activationAction?: { readonly busy: boolean; readonly onClick: () => void } | undefined;
  onSelect: (value: string) => void;
  onBack?: () => void;
  searchbarClassName?: string | undefined;
  groupLabelClassName?: string | undefined;
  itemClassName?: string | undefined;
  itemLabelClassName?: string | undefined;
}) {
  const [query, setQuery] = useState("");
  const listBodyRef = useRef<HTMLDivElement>(null);
  const hasSearchQuery = query.trim().length > 0;
  const setupLabel =
    provider === "opencodeV2" ? "Native availability unverified" : "Provider not connected";

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
  const modelList = useIncrementalList({
    items: filtered,
    resetKey: JSON.stringify([provider, query]),
    initialCount: INITIAL_VISIBLE_MODEL_COUNT,
    increment: VISIBLE_MODEL_COUNT_INCREMENT,
  });
  const renderedOptions = modelList.items;

  const showRecentOptions = Boolean(recentOptions && recentOptions.length > 0 && !hasSearchQuery);
  const grouped = useMemo(() => groupModelOptions(renderedOptions), [renderedOptions]);
  const hasVisibleModels = grouped.length > 0;
  const hasNamedGroups = grouped.some((group) => group.kind === "named");
  const showLoadingState = loading && options.length === 0;
  const showEmptyState = !showLoadingState && !hasVisibleModels && !showRecentOptions;

  return (
    <SearchableMenuList
      query={query}
      onQueryChange={setQuery}
      placeholder="Search models"
      backAriaLabel="Back to provider selection"
      searchbarClassName={searchbarClassName}
      onBack={onBack}
      bodyProps={
        {
          ref: listBodyRef,
          "data-testid": "provider-model-list-scroll",
          onScroll: (event) => modelList.onScroll(event.currentTarget),
          onWheel: (event) => modelList.onWheel(event.currentTarget, event.deltaY),
        } as ComponentProps<"div">
      }
    >
      <MenuRadioGroup value={selectedValue} onValueChange={onSelect}>
        {showLoadingState ? (
          <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground/70">
            <Spinner className="size-3" />
            <span>Loading models...</span>
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
                {modelOption.availability === "requires-setup" ? (
                  <span className="ms-auto text-xs text-muted-foreground">{setupLabel}</span>
                ) : null}
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
                  {modelOption.availability === "requires-setup" ? (
                    <span className="ms-auto text-xs text-muted-foreground">{setupLabel}</span>
                  ) : null}
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
                {modelOption.availability === "requires-setup" ? (
                  <span className="ms-auto text-xs text-muted-foreground">{setupLabel}</span>
                ) : null}
              </MenuRadioItem>
            ))}
          </MenuGroup>
        ) : null}
      </MenuRadioGroup>
      {provider === "opencodeV2" && options.length === 0 && !loading ? (
        <>
          {unavailableMessage ? (
            <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
              {unavailableMessage}
            </p>
          ) : null}
          {allowOpenCodeSetup ? <OpenCodeSetupMenuItem message={unavailableMessage} /> : null}
        </>
      ) : null}
      {modelList.hasMore ? (
        <Button variant="ghost" size="sm" className="w-full text-xs" onClick={modelList.loadMore}>
          Show more models
        </Button>
      ) : null}
    </SearchableMenuList>
  );
}
