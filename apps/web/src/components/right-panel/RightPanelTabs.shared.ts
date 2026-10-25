import {
  ActivityIcon,
  Columns3Icon,
  DiffIcon,
  GitBranchIcon,
  GlobeIcon,
  NotebookTextIcon,
  TerminalIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import type { RightPanelTabKind } from "~/stores/rightPanel/rightPanelTabs.store";
import { RightPanelFilesIcon } from "./RightPanel.filesIcon";
import { UsageIcon } from "../usage/UsageIcon";

export const TAB_LABELS: Record<RightPanelTabKind, string> = {
  browser: "Browser",
  diff: "Diff",
  files: "Files",
  git: "Git",
  kanban: "Kanban",
  notes: "Notes",
  usage: "Usage",
  system: "System",
  terminal: "Terminal",
};

export const TAB_ICONS: Record<RightPanelTabKind, ComponentType<{ className?: string }>> = {
  browser: GlobeIcon,
  diff: DiffIcon,
  files: RightPanelFilesIcon,
  git: GitBranchIcon,
  kanban: Columns3Icon,
  notes: NotebookTextIcon,
  usage: UsageIcon,
  system: ActivityIcon,
  terminal: TerminalIcon,
};
