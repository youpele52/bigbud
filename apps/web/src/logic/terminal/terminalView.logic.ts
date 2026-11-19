interface TerminalPaneLayout {
  readonly terminalOpen?: boolean;
  readonly activeTerminalGroupId: string;
  readonly terminalGroups: ReadonlyArray<{
    readonly id: string;
    readonly terminalIds: readonly string[];
  }>;
}

const MAX_VIEWED_PANES = 16;

function activeGroupIds(layout: TerminalPaneLayout | undefined): readonly string[] {
  if (!layout) return [];
  return (
    layout.terminalGroups.find((group) => group.id === layout.activeTerminalGroupId)?.terminalIds ??
    []
  );
}

/** Panes the user can see in the open thread: the active split group of the open drawer/panel. */
export function visibleTerminalIds(input: {
  readonly drawer: TerminalPaneLayout | undefined;
  readonly panel: TerminalPaneLayout | undefined;
  readonly panelOpen: boolean;
}): string[] {
  const ids = new Set<string>();
  if (input.drawer?.terminalOpen) for (const id of activeGroupIds(input.drawer)) ids.add(id);
  if (input.panelOpen) for (const id of activeGroupIds(input.panel)) ids.add(id);
  return [...ids].slice(0, MAX_VIEWED_PANES);
}
