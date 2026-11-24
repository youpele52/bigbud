import type { ContextMenuItem } from "@bigbud/contracts/server/ipc.ts";

import type { RemoteTargetMenuItem } from "../../lib/remoteTargetMenu";
import type { SidebarThreadSummary } from "../../models/types";
import { buildInyosiraMoveMenuItem, buildInyosiraSnoozeMenuItem } from "./Sidebar.inyosira.menu";

export function normalizeSummaryText(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

/** The elevator summary is offered only when it says more than the title. */
export function resolveThreadElevatorSummary(
  thread: Pick<SidebarThreadSummary, "title" | "elevatorSummary">,
): string | null {
  const summary = normalizeSummaryText(thread.elevatorSummary);
  return summary.length > 0 && summary !== normalizeSummaryText(thread.title) ? summary : null;
}

/**
 * Single-thread context menu. For a thread of an SSH workspace, "Edit remote workspace" and the
 * workspace menu's connection controls (`remoteItems`: Reconnect then Disconnect, or Connect)
 * form their own section between Archive and Delete, with a divider on each side.
 */
export function buildThreadContextMenuItems(input: {
  readonly thread: Pick<
    SidebarThreadSummary,
    "title" | "elevatorSummary" | "pinnedAt" | "organization"
  >;
  readonly remoteItems: readonly RemoteTargetMenuItem[];
  /** True only for a resolved SSH workspace project, matching the workspace menu. */
  readonly canEditRemoteWorkspace?: boolean;
}): ContextMenuItem[] {
  const { thread } = input;
  return [
    { id: "rename", label: "Rename thread" },
    { id: "generate-title", label: "Generate title…" },
    { id: "branch", label: "Branch thread" },
    buildInyosiraMoveMenuItem(thread.organization),
    buildInyosiraSnoozeMenuItem(thread.organization),
    {
      id: "favorite",
      label: (thread.pinnedAt ?? null) !== null ? "Unpin thread" : "Pin thread",
    },
    { id: "separator-actions", label: "", separator: true },
    {
      id: "copy-elevator-summary",
      label: "Elevator summary",
      disabled: resolveThreadElevatorSummary(thread) === null,
    },
    { id: "copy-thread-id", label: "Copy Thread ID" },
    { id: "copy-path", label: "Copy Path" },
    { id: "archive", label: "Archive thread" },
    // The connection controls are their own section: a divider before and after them.
    ...(input.remoteItems.length > 0
      ? [
          { id: "separator-remote", label: "", separator: true },
          ...(input.canEditRemoteWorkspace
            ? [{ id: "edit-ssh", label: "Edit remote workspace" }]
            : []),
          ...input.remoteItems,
        ]
      : []),
    { id: "separator-delete", label: "", separator: true },
    { id: "delete", label: "Delete", destructive: true },
  ];
}
