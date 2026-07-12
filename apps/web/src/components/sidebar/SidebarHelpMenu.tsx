import {
  BookOpenIcon,
  CircleHelpIcon,
  KeyboardIcon,
  MessageCircleIcon,
  NewspaperIcon,
  PlayIcon,
} from "lucide-react";
import { Fragment } from "react";
import { useSidebar } from "../ui/sidebar";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openBrowserPanel } from "~/stores/browser/browserPanel.actions";

const helpMenuItems = [
  {
    icon: BookOpenIcon,
    label: "Getting started",
    url: "https://bigbud.app/docs/#getting-started",
  },
  {
    icon: BookOpenIcon,
    label: "Using bigbud",
    url: "https://bigbud.app/docs/#using-bigbud",
  },
  {
    icon: NewspaperIcon,
    label: "What's new",
    url: "https://bigbud.app/changelog/",
  },
  {
    icon: KeyboardIcon,
    label: "Keyboard shortcuts",
    url: "https://bigbud.app/docs/#6-keyboard-shortcuts",
  },
  {
    icon: PlayIcon,
    label: "Tutorials",
    url: "https://www.youtube.com/@bigbudapp",
  },
  {
    icon: MessageCircleIcon,
    label: "Follow bigbud on X",
    url: "https://x.com/bigbudapp",
  },
] as const;

export function SidebarHelpMenu() {
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              aria-label="Help"
              className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            />
          }
        >
          <CircleHelpIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="right">Help</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="top" className="min-w-52">
        {helpMenuItems.map(({ icon: Icon, label, url }, index) => (
          <Fragment key={url}>
            <MenuItem
              className="min-h-7 py-1 text-xs"
              onClick={() => {
                openBrowserPanel({ url });
                if (isMobile) {
                  setOpenMobile(false);
                }
              }}
            >
              <Icon className="size-3.5 text-muted-foreground/70" />
              <span className="truncate text-xs">{label}</span>
            </MenuItem>
            {index === 0 ? <MenuSeparator /> : null}
          </Fragment>
        ))}
      </MenuPopup>
    </Menu>
  );
}
