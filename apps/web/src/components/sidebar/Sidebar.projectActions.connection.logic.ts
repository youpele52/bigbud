import type { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas";

import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { isSessionActivelyRunningTurn } from "../../logic/session/session.logic";
import type { Project, SidebarThreadSummary } from "../../models/types";
import { parseRemoteExecutionTarget } from "./Sidebar.remoteWorkspaces.logic";

export type ConnectionActivityThread = Pick<
  SidebarThreadSummary,
  | "id"
  | "projectId"
  | "workspaceExecutionTargetId"
  | "executionTargetId"
  | "providerRuntimeExecutionTargetId"
  | "session"
  | "latestTurn"
>;

export interface ExecutionTargetActivity {
  readonly activeTurnCount: number;
  readonly runningTerminalCount: number;
  /** Names of the other workspaces that share this SSH connection. */
  readonly sharedWorkspaceNames: readonly string[];
}

export interface PendingDisconnectConfirmation extends ExecutionTargetActivity {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly executionTargetId: string;
}

/** A thread without its own target lives in its project's workspace. */
function threadUsesExecutionTarget(
  thread: ConnectionActivityThread,
  executionTargetId: string,
  projectTargetById: ReadonlyMap<ProjectId, string>,
): boolean {
  const workspaceTarget =
    thread.workspaceExecutionTargetId !== undefined || thread.executionTargetId !== undefined
      ? resolveWorkspaceExecutionTargetId(thread)
      : projectTargetById.get(thread.projectId);
  return (
    workspaceTarget === executionTargetId ||
    thread.providerRuntimeExecutionTargetId === executionTargetId
  );
}

export function summarizeExecutionTargetActivity(input: {
  readonly executionTargetId: string;
  readonly projectId: ProjectId;
  readonly projects: readonly Project[];
  readonly threads: Iterable<ConnectionActivityThread>;
  readonly runningTerminalIds: (threadId: ThreadId) => readonly string[];
}): ExecutionTargetActivity {
  const projectTargetById = new Map(
    input.projects.map((project) => [project.id, resolveWorkspaceExecutionTargetId(project)]),
  );
  let activeTurnCount = 0;
  let runningTerminalCount = 0;
  for (const thread of input.threads) {
    if (!threadUsesExecutionTarget(thread, input.executionTargetId, projectTargetById)) continue;
    if (isSessionActivelyRunningTurn(thread.latestTurn, thread.session)) activeTurnCount += 1;
    runningTerminalCount += input.runningTerminalIds(thread.id).length;
  }
  const sharedWorkspaceNames = input.projects
    .filter(
      (project) =>
        project.id !== input.projectId &&
        projectTargetById.get(project.id) === input.executionTargetId,
    )
    .map((project) => project.name);
  return { activeTurnCount, runningTerminalCount, sharedWorkspaceNames };
}

/** Disconnect asks first only when it would cut off running work. */
export function shouldConfirmDisconnect(activity: ExecutionTargetActivity): boolean {
  return activity.activeTurnCount > 0 || activity.runningTerminalCount > 0;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Agent work survives on the host; direct SSH shells end with their connection. */
function transportConsequence(executionTargetId: string): string {
  return parseRemoteExecutionTarget(executionTargetId)?.remoteTransport === "direct-ssh"
    ? "Terminals will close, and commands running in them on the host will end."
    : "Work run by the bigbud remote agent keeps running on the host and reattaches after you connect again.";
}

export function describeDisconnectConfirmation(confirmation: PendingDisconnectConfirmation): {
  readonly title: string;
  readonly description: string;
} {
  const work = [
    ...(confirmation.activeTurnCount > 0
      ? [plural(confirmation.activeTurnCount, "running turn")]
      : []),
    ...(confirmation.runningTerminalCount > 0
      ? [plural(confirmation.runningTerminalCount, "running terminal")]
      : []),
  ].join(" and ");
  const sharedCount = confirmation.sharedWorkspaceNames.length;
  const shared =
    sharedCount > 0
      ? ` ${plural(sharedCount, "other workspace")} ${sharedCount === 1 ? "shares" : "share"} this connection and will also disconnect.`
      : "";
  return {
    title: `Disconnect "${confirmation.projectName}"?`,
    description: `${work} will lose the connection, and active turns will stop. ${transportConsequence(confirmation.executionTargetId)}${shared}`,
  };
}

export type ProjectOpenAction = "toggle" | "connect" | "check";

/**
 * Clicking a workspace row: local or verified workspaces just toggle; a workspace the
 * user disconnected reconnects; any other remote workspace runs the access check first.
 */
export function resolveProjectOpenAction(input: {
  readonly isRemoteWorkspace: boolean;
  readonly isVerified: boolean;
  readonly isUserDisconnected: boolean;
}): ProjectOpenAction {
  if (!input.isRemoteWorkspace) return "toggle";
  if (input.isUserDisconnected) return "connect";
  return input.isVerified ? "toggle" : "check";
}
