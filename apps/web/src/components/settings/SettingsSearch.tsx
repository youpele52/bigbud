import { SearchIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { Input } from "../ui/input";
import { getSettingsSearchResults, normalizeSettingsSearchQuery } from "./SettingsSearch.logic";
import type { SETTINGS_SEARCH_ITEMS } from "./SettingsSidebarNav.items";

const MAX_RESULTS = 6;

export function SettingsSearch({
  query,
  onQueryChange,
}: {
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const navigate = useNavigate();
  const normalizedQuery = normalizeSettingsSearchQuery(query);
  const results = getSettingsSearchResults(query).slice(0, MAX_RESULTS);

  const selectResult = (result: (typeof SETTINGS_SEARCH_ITEMS)[number]) => {
    void navigate({ to: result.to, replace: true });
  };

  return (
    <div className="relative ms-2 w-52 shrink-0 [-webkit-app-region:no-drag] sm:w-64">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        size="sm"
        value={query}
        placeholder="Search settings"
        aria-label="Search settings"
        aria-controls={normalizedQuery ? "settings-search-results" : undefined}
        aria-expanded={Boolean(normalizedQuery)}
        className="bg-background/60 ps-7"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && results[0]) {
            event.preventDefault();
            selectResult(results[0]);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onQueryChange("");
            event.currentTarget.blur();
          }
        }}
      />
      {normalizedQuery ? (
        <div
          id="settings-search-results"
          className="absolute top-[calc(100%+0.25rem)] left-0 z-50 w-full overflow-hidden rounded-lg border bg-popover py-1 shadow-lg/5"
        >
          {results.length > 0 ? (
            results.map((result) => (
              <button
                key={`${result.to}-${result.label}`}
                type="button"
                className="flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectResult(result)}
              >
                <span>{result.label}</span>
                <span className="text-xs text-muted-foreground">{result.section}</span>
              </button>
            ))
          ) : (
            <p className="px-3 py-2 text-xs text-muted-foreground">No settings found.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
