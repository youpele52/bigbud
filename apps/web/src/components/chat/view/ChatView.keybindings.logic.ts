import type { ResolvedKeybindingsConfig } from "@bigbud/contracts";
import { useEffect } from "react";
import { resolveShortcutCommand } from "../../../models/keybindings";
import { isTerminalFocused } from "../../../lib/terminalFocus";
import { projectScriptIdFromCommand } from "../../../logic/project-scripts";
import type { Project } from "../../../models/types";
import { toggleGitPanel } from "~/stores/git/gitPanel.coordinator";

interface TerminalState {
  terminalOpen: boolean;
  activeTerminalId: string;
}

export interface UseChatKeybindingsInput {
  enabled?: boolean;
  activeThreadId: string | null;
  activeProject: Project | null | undefined;
  terminalState: TerminalState;
  keybindings: ResolvedKeybindingsConfig;
  toggleTerminalVisibility: () => void;
  toggleTerminalPanel: () => void;
  setTerminalOpen: (open: boolean) => void;
  splitTerminal: () => void;
  closeTerminal: (terminalId: string) => void;
  createNewTerminal: () => void;
  onToggleDiff: () => void;
  runProjectScript: (script: Project["scripts"][number]) => void;
}

/** Registers global keydown handler for all ChatView keyboard shortcuts. */
export function useChatKeybindings({
  enabled = true,
  activeThreadId,
  activeProject,
  terminalState,
  keybindings,
  toggleTerminalVisibility,
  toggleTerminalPanel,
  setTerminalOpen,
  splitTerminal,
  closeTerminal,
  createNewTerminal,
  onToggleDiff,
  runProjectScript,
}: UseChatKeybindingsInput): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || event.defaultPrevented) return;
      const shortcutContext = {
        terminalFocus: isTerminalFocused(),
        terminalOpen: Boolean(terminalState.terminalOpen),
      };

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "terminalPanel.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalPanel();
        return;
      }

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal();
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) return;
        closeTerminal(terminalState.activeTerminalId);
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        createNewTerminal();
        return;
      }

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleDiff();
        return;
      }

      if (command === "git.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleGitPanel();
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [
    activeProject,
    enabled,
    terminalState.terminalOpen,
    terminalState.activeTerminalId,
    activeThreadId,
    closeTerminal,
    createNewTerminal,
    setTerminalOpen,
    runProjectScript,
    splitTerminal,
    keybindings,
    onToggleDiff,
    toggleTerminalPanel,
    toggleTerminalVisibility,
  ]);
}
