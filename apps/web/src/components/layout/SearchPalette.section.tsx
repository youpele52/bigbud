import { CommandGroupLabel } from "../ui/command";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar.menu";

/** Uppercase heading shared by every palette section. */
export function SearchPaletteSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <CommandGroupLabel className="px-2 pb-1 text-muted-foreground/80 uppercase tracking-[0.08em]">
      {children}
    </CommandGroupLabel>
  );
}

/** "See more" row under a palette section; `remaining` is omitted when more server pages exist. */
export function SearchPaletteSeeMore({
  remaining,
  indent = false,
  onClick,
}: {
  remaining?: number | undefined;
  indent?: boolean;
  onClick: () => void;
}) {
  return (
    <SidebarMenuSubItem className={indent ? "w-full px-2 pt-1 pl-9" : "w-full px-2 pt-1"}>
      <SidebarMenuSubButton
        render={<button type="button" />}
        size="sm"
        className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
        onClick={onClick}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span>{remaining === undefined ? "See more" : `See more (${remaining})`}</span>
        </span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}
