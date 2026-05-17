import { SearchIcon } from "lucide-react";
import { SIDEBAR_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";
import { useSearchStore } from "../../stores/ui/search.store";
import { SidebarGroup } from "../ui/sidebar";

export function SidebarSearchSection() {
  const toggleSearchOpen = useSearchStore((state) => state.toggleSearchOpen);

  return (
    <SidebarGroup className="px-2 py-2">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 transition-colors hover:bg-accent hover:text-muted-foreground/80"
        onClick={toggleSearchOpen}
      >
        <SearchIcon className={`${SIDEBAR_ICON_SIZE_CLASS} shrink-0`} />
        <span>Search</span>
      </button>
    </SidebarGroup>
  );
}
