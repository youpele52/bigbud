import type { NativeApi, ProjectId, ThreadId } from "@bigbud/contracts";

import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { useStore } from "../../stores/main";
import { useTerminalStateStore } from "../../stores/terminal";
import { selectThreadTerminalState } from "../../stores/terminal/helpers.store";
import { closeTerminalConfirmed } from "../terminal/terminalLifecycle.operations";

interface WorkspaceTerminal {
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

/** Every terminal pane (thread drawer and panel) open in a project's threads. */
export function listWorkspaceTerminals(projectId: ProjectId): WorkspaceTerminal[] {
  const threads = Object.values(useStore.getState().sidebarThreadsById).filter(
    (thread) => thread?.projectId === projectId,
  );
  const { terminalStateByThreadId, panelTerminalStateByThreadId } =
    useTerminalStateStore.getState();
  return threads.flatMap((thread) => {
    if (!thread) return [];
    const ids = new Set([
      ...selectThreadTerminalState(terminalStateByThreadId, thread.id).terminalIds,
      ...selectThreadTerminalState(panelTerminalStateByThreadId, thread.id).terminalIds,
    ]);
    return [...ids].map((terminalId) => ({ threadId: thread.id, terminalId }));
  });
}

/**
 * Changing how a workspace connects needs its terminals closed first (the server refuses while
 * any shell is open). Ask once, then close them all and wait for each confirmed close.
 * Returns an error message to show, or null to continue saving.
 */
export async function closeTerminalsForConnectionChange(input: {
  readonly api: NativeApi;
  readonly projectId: ProjectId;
  readonly nextWorkspaceExecutionTargetId: string;
}): Promise<string | null> {
  const project = useStore.getState().projects.find((entry) => entry.id === input.projectId);
  if (!project) return null;
  const currentTarget = resolveWorkspaceExecutionTargetId(project);
  if (currentTarget === input.nextWorkspaceExecutionTargetId) return null;
  const terminals = listWorkspaceTerminals(input.projectId);
  if (terminals.length === 0) return null;
  const proceed = await input.api.dialogs.confirm(
    "Changing how this workspace connects closes every open terminal in it. Continue?",
  );
  if (!proceed) return "Nothing was saved. Your terminals are still open.";
  await Promise.all(
    terminals.map(({ threadId, terminalId }) =>
      closeTerminalConfirmed({
        api: input.api,
        threadId,
        terminalId,
        executionTargetId: currentTarget,
        onConfirmed: () => {
          const store = useTerminalStateStore.getState();
          store.closeTerminal(threadId, terminalId);
          store.closePanelTerminal(threadId, terminalId);
        },
      }),
    ),
  );
  // A failed or unconfirmed close leaves its pane in place (with its own error); never save then.
  const remaining = listWorkspaceTerminals(input.projectId).length;
  return remaining > 0
    ? `${remaining} ${remaining === 1 ? "terminal" : "terminals"} could not be closed, so nothing was saved. Check the terminal, then try again.`
    : null;
}
