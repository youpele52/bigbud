import { type KeybindingCommand, type ProjectScript, type ProjectId } from "@bigbud/contracts";
import { useCallback } from "react";
import { isElectron } from "../../../config/env";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { commandForProjectScript, nextProjectScriptId } from "../../../logic/project-scripts";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "../../../rpc/nativeApi";
import { toastManager } from "../../ui/toast";
import type { NewProjectScriptInput } from "../../project/ProjectScriptsControl";
import type { Project } from "../../../models/types";

export interface UseProjectScriptsInput {
  activeProject: Project | undefined;
}

export interface UseProjectScriptsResult {
  persistProjectScripts: (input: {
    projectId: ProjectId;
    projectCwd: string | null;
    previousScripts: ProjectScript[];
    nextScripts: ProjectScript[];
    keybinding?: string | null;
    keybindingCommand: KeybindingCommand;
  }) => Promise<void>;
  saveProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  updateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  deleteProjectScript: (scriptId: string) => Promise<void>;
}

export function useProjectScripts(input: UseProjectScriptsInput): UseProjectScriptsResult {
  const { activeProject } = input;

  const persistProjectScripts = useCallback(
    async (persistInput: {
      projectId: ProjectId;
      projectCwd: string | null;
      previousScripts: ProjectScript[];
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      const api = readNativeApi();
      if (!api) return;

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: persistInput.projectId,
        scripts: persistInput.nextScripts,
      });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: persistInput.keybinding,
        command: persistInput.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        await api.server.upsertKeybinding(keybindingRule);
      }
    },
    [],
  );

  const saveProjectScript = useCallback(
    async (saveInput: NewProjectScriptInput) => {
      if (!activeProject) return;
      if (!activeProject.cwd) {
        throw new Error("Project actions are unavailable for chats without a project folder.");
      }
      const nextId = nextProjectScriptId(
        saveInput.name,
        activeProject.scripts.map((script) => script.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: saveInput.name,
        command: saveInput.command,
        icon: saveInput.icon,
        runOnWorktreeCreate: saveInput.runOnWorktreeCreate,
      };
      const nextScripts = saveInput.runOnWorktreeCreate
        ? [
            ...activeProject.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProject.scripts, nextScript];

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: saveInput.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, persistProjectScripts],
  );

  const updateProjectScript = useCallback(
    async (scriptId: string, updateInput: NewProjectScriptInput) => {
      if (!activeProject) return;
      if (!activeProject.cwd) {
        throw new Error("Project actions are unavailable for chats without a project folder.");
      }
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        throw new Error("Script not found.");
      }

      const updatedScript: ProjectScript = {
        ...existingScript,
        name: updateInput.name,
        command: updateInput.command,
        icon: updateInput.icon,
        runOnWorktreeCreate: updateInput.runOnWorktreeCreate,
      };
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : updateInput.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: updateInput.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );

  const deleteProjectScript = useCallback(
    async (scriptId: string) => {
      if (!activeProject) return;
      if (!activeProject.cwd) {
        throw new Error("Project actions are unavailable for chats without a project folder.");
      }
      const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId);

      const deletedName = activeProject.scripts.find((s) => s.id === scriptId)?.name;

      try {
        await persistProjectScripts({
          projectId: activeProject.id,
          projectCwd: activeProject.cwd,
          previousScripts: activeProject.scripts,
          nextScripts,
          keybinding: null,
          keybindingCommand: commandForProjectScript(scriptId),
        });
        toastManager.add({
          type: "success",
          title: `Deleted action "${deletedName ?? "Unknown"}"`,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not delete action",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [activeProject, persistProjectScripts],
  );

  return { persistProjectScripts, saveProjectScript, updateProjectScript, deleteProjectScript };
}
