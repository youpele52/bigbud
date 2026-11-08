import { create } from "zustand";
import type { ProjectId, CommandId } from "@bigbud/contracts";
import type { Project } from "../../models/types";
import {
  dispatchCommandWithOutcomeRecovery,
  OrchestrationCommandOutcomeError,
} from "../../lib/orchestrationCommandRecovery";
import type { ClientOrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import {
  readProjectEditRecovery,
  retainProjectEdit,
  clearProjectEdit,
} from "./Sidebar.projectEdit.recovery";
import { newCommandId } from "../../lib/utils";
import { ensureNativeApi } from "../../rpc/nativeApi";

export const useProjectEditor = create<{
  projectId: ProjectId | null;
  open: (projectId: ProjectId) => void;
  close: () => void;
}>((set) => ({
  projectId: null,
  open: (projectId) => set({ projectId }),
  close: () => set({ projectId: null }),
}));

export async function saveLocalProject(input: {
  project: Project;
  title: string;
  directory: string;
  action?: "switch" | "transfer" | undefined;
  nativeContextReset?: boolean;
  commandId?: CommandId;
}) {
  const api = ensureNativeApi();
  const title = input.title.trim();
  if (!title) throw new Error("Project name is required.");
  const directory = input.directory.trim();
  if (readProjectEditRecovery(input.project.id))
    throw new Error("Check the retained edit before submitting another change.");
  let command: ClientOrchestrationCommand;
  if (directory === (input.project.cwd ?? "")) {
    command = {
      type: "project.meta.update",
      commandId: input.commandId ?? newCommandId(),
      projectId: input.project.id,
      title,
    };
  } else {
    if (!directory) throw new Error("Select a directory, or keep the existing managed location.");
    if (!input.project.updatedAt) throw new Error("Reload the project before editing its folder.");
    command = {
      type: "project.reconfigure",
      commandId: input.commandId ?? newCommandId(),
      projectId: input.project.id,
      title,
      workspaceRoot: directory,
      providerRuntimeExecutionTargetId: input.project.providerRuntimeExecutionTargetId ?? "local",
      workspaceExecutionTargetId: "local",
      executionTargetId: "local",
      expectedUpdatedAt: input.project.updatedAt,
      verifiedWorktreePaths: [],
      ...(input.action ? { workspaceAction: input.action } : {}),
      ...(input.nativeContextReset
        ? { nativeContextReset: "archive-and-reset-muse" as const }
        : {}),
    };
  }
  retainProjectEdit(input.project.id, { command, error: null });
  try {
    await dispatchCommandWithOutcomeRecovery(api, command);
    clearProjectEdit(input.project.id);
  } catch (cause) {
    if (cause instanceof OrchestrationCommandOutcomeError && cause.status === "rejected")
      clearProjectEdit(input.project.id);
    else
      retainProjectEdit(input.project.id, {
        command,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    throw cause;
  }
}
