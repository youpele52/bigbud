import { SearchIcon } from "lucide-react";

import { Input } from "../ui/input";

interface PluginSearchProps {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
}

export function PluginSearch({ query, onQueryChange }: PluginSearchProps) {
  return (
    <div className="relative ms-2 w-52 shrink-0 [-webkit-app-region:no-drag] sm:w-64">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        size="sm"
        value={query}
        placeholder="Search plugins"
        aria-label="Search plugins"
        className="bg-background/60 ps-7"
        onChange={(event) => onQueryChange(event.target.value)}
      />
    </div>
  );
}
