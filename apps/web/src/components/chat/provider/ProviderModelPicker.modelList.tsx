import { type ProviderKind } from "@bigbud/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Searchbar } from "../../ui/Searchbar";
import { MenuGroup, MenuGroupLabel, MenuRadioGroup, MenuRadioItem } from "../../ui/menu";
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
  onSelect,
  onBack,
}: {
  provider: ProviderKind;
  selectedValue: string;
  options: ReadonlyArray<ModelOption>;
  recentOptions?: ReadonlyArray<ModelOption> | undefined;
  onSelect: (value: string) => void;
  onBack?: () => void;
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
  const showEmptyState = !hasVisibleModels && !showRecentOptions;

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
        {showRecentOptions && recentOptions ? (
          <MenuGroup>
            <MenuGroupLabel>Recently used</MenuGroupLabel>
            {recentOptions.map((modelOption) => (
              <MenuRadioItem
                key={`recent:${provider}:${modelOptionValue(modelOption)}`}
                value={modelOptionValue(modelOption)}
              >
                {modelOption.name}
              </MenuRadioItem>
            ))}
          </MenuGroup>
        ) : null}
        {showEmptyState ? (
          <div className="px-3 py-4 text-center text-sm text-muted-foreground/60">
            No models match &ldquo;{query}&rdquo;
          </div>
        ) : hasNamedGroups ? (
          grouped.map((section) => (
            <MenuGroup key={section.kind === "named" ? section.group : "__ungrouped"}>
              {section.kind === "named" ? <MenuGroupLabel>{section.group}</MenuGroupLabel> : null}
              {section.models.map((modelOption) => (
                <MenuRadioItem
                  key={`${provider}:${modelOptionValue(modelOption)}`}
                  value={modelOptionValue(modelOption)}
                >
                  {modelOption.name}
                </MenuRadioItem>
              ))}
            </MenuGroup>
          ))
        ) : hasVisibleModels ? (
          <MenuGroup>
            {filtered.map((modelOption) => (
              <MenuRadioItem
                key={`${provider}:${modelOptionValue(modelOption)}`}
                value={modelOptionValue(modelOption)}
              >
                {modelOption.name}
              </MenuRadioItem>
            ))}
          </MenuGroup>
        ) : null}
      </MenuRadioGroup>
    </div>
  );
}
